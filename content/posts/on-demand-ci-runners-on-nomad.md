---
title: "On-Demand CI Runners on Nomad with Temporal"
date: 2026-09-25
description: "Ephemeral self-hosted GitHub Actions runners that only exist while a job is queued, with a registration token minted per runner."
links:
  - { label: "Project page", url: "https://nomad-temporal-jobs.munchbox.cc" }
  - { label: "Runner scaler diagram", url: "https://nomad-temporal-jobs.munchbox.cc/diagrams/runnerscaler-workflow/" }
  - { label: "Source on GitHub", url: "https://github.com/afreidah/nomad-temporal-jobs/tree/main/runnerscaler" }
---

Some of my CI can't run on GitHub-hosted runners. Pushing images to my Docker registry, deploying updated Nomad jobs, and applying Terragrunt, which covers everything from cloud instances and DNS to Vault policies and ACLs, all need to reach the cluster, so they have to run inside it. The usual answer is self-hosted runners sitting in Nomad waiting for work, and on a personal account that gets ugly fast. Outside an org, a self-hosted runner can only be registered to one repo. CI for six repos means six runners, each registered by hand with its own token, and all of them tying up a real slice of a homelab cluster to do nothing most of the day.

I was already running Temporal on the cluster for nightly backups, snapshots, and general maintenance, so I got to thinking I could set up a polling workflow to watch my repos and dispatch a parameterized Nomad job with the right registration token, repo, labels, and image plugged in.

## The shape

<pre class="diagram"><span class="hl">Temporal Schedule</span> (every 30s)
        |
        v
<span class="hl">PollAndDispatch</span>
  - load per-repo config from Consul KV
  - list queued self-hosted jobs per repo
  - count runners already pending/running
  - start one HandleRunner child per missing runner
        |
        v
<span class="hl">HandleRunner</span> (one per runner)
  - mint a registration token
  - nomad job dispatch ci-runner (token passed as meta)
  - wait for the allocation to finish
  - stop the dispatched job
</pre>

The project page has a more detailed [diagram of this flow](https://nomad-temporal-jobs.munchbox.cc/diagrams/runnerscaler-workflow/), where hovering over any step shows how it's implemented.

The runner itself is a Nomad parameterized batch job. Every dispatch is one ephemeral runner: it registers, takes exactly one job, deregisters, and exits. Restarts and rescheduling are off, because a finished runner should stay finished.

Here's the runner job:

```hcl
# CI Runner — on-demand ephemeral GitHub Actions runner (parameterized)
#
# Each dispatch spawns one ephemeral self-hosted runner that takes a single job,
# then deregisters and exits. Dispatched by the Temporal poller, which mints the
# registration token and passes it as meta.

job "ci-runner" {
  region      = "global"
  datacenters = ["munchbox"]
  type        = "batch"
  node_pool   = "default"

  # Dispatched per CI run; meta carries the target repo + minted token
  parameterized {
    meta_required = ["repo_url", "runner_token"]
    meta_optional = ["labels"]
  }

  # Default labels when a dispatch omits them
  meta {
    labels = "self-hosted"
  }

  group "runner" {
    count = 1

    # amd64-only image; keep it off arm64 nodes (Pi5s) where it can't run
    constraint {
      attribute = "${attr.cpu.arch}"
      value     = "amd64"
    }

    network {
      mode = "host"
    }

    # One-shot: an ephemeral runner runs a single job then exits; never
    # restart or reschedule a finished/failed runner
    restart {
      attempts = 0
      mode     = "fail"
    }

    reschedule {
      attempts  = 0
      unlimited = false
    }

    task "runner" {
      driver = "docker"

      # WI exchanged for a Vault token so the template below can read the
      # scoped Nomad ACL token. Role + policy live in terragrunt vault-config.
      vault {
        role        = "ci-runner"
        change_mode = "noop"
      }

      # The default WI (identity.env) carries no Nomad policy; the scoped
      # NOMAD_TOKEN templated in below overrides it.
      identity {
        env  = true
        file = true
        aud  = ["vault.io"]
      }

      config {
        image = "registry.munchbox.cc/ci-runner:latest"
        # force_pull so a rebuilt :latest (e.g. a tool version bump) is picked up
        # on the next dispatch instead of a stale cached image.
        force_pull         = true
        image_pull_timeout = "10m"
        volumes = [
          # pki_int signs the Nomad server cert; this CA backs NOMAD_CACERT.
          "/opt/nomad/tls/vault-intermediate-ca.pem:/etc/ssl/certs/munchbox-ca.pem:ro",
        ]
      }

      # Scoped Nomad ACL token (submit-job) for `nomad job validate`/`plan`.
      # Minted by terragrunt nomad-acls -> secret/ci-runner-nomad.
      template {
        data        = <<-EOF
        {{ with secret "secret/data/ci-runner-nomad" }}
        NOMAD_TOKEN={{ .Data.data.nomad_token }}
        {{ end }}
        EOF
        destination = "secrets/nomad.env"
        env         = true
      }

      env {
        RUNNER_SCOPE        = "repo"
        REPO_URL            = "${NOMAD_META_repo_url}"
        RUNNER_TOKEN        = "${NOMAD_META_runner_token}"
        LABELS              = "${NOMAD_META_labels}"
        EPHEMERAL           = "true"
        DISABLE_AUTO_UPDATE = "true"
        RUN_AS_ROOT         = "false"
        RUNNER_NAME         = "ci-runner-${NOMAD_ALLOC_ID}"
        RUNNER_WORKDIR      = "/tmp/runner-work"

        # Nomad API for `nomad job validate`/`plan`; NOMAD_TOKEN from template
        NOMAD_ADDR            = "https://192.168.68.61:4646"
        NOMAD_TLS_SERVER_NAME = "server.global.nomad"
        NOMAD_CACERT          = "/etc/ssl/certs/munchbox-ca.pem"
      }

      # Ephemeral one-shot, so a flat reservation has no idle cost (no need
      # for memory_max/oversubscription)
      resources {
        cpu    = 2000
        memory = 2048
      }
    }
  }
}
```

## Talking to Nomad

Everything the scaler does to Nomad goes through a small wrapper around the official Go client, `github.com/hashicorp/nomad/api`. Dispatching a runner is a single `Jobs().Dispatch` call that returns the ID of the concrete dispatched job, and reaping one is a `Deregister` with purge, so finished dispatch jobs don't pile up in Nomad's state. The two calls worth showing are the ones the reconcile and the wait depend on.

Counting the runners already in flight doesn't need any state of its own. Every dispatched runner is a child job named `<parent>/dispatch-…`, and its meta still carries the repo and labels it was dispatched with, so Nomad already knows everything the reconcile needs:

```go
// ActiveRunnerSlots returns the dispatch identity of every active (pending or
// running) dispatched child of parentJobID. It lists allocations, keeps those
// whose job is a dispatched child still occupying a slot, and reads each child
// job's repo_url + labels meta. A child whose job info can't be fetched (already
// garbage-collected) is skipped -- it no longer occupies a slot. Ephemeral
// runners aren't bound to a specific job, so the caller reconciles by counting
// these against queued jobs rather than tracking a runner per job_id.
func (n *Nomad) ActiveRunnerSlots(ctx context.Context, parentJobID string) ([]RunnerSlot, error) {
	allocs, _, err := n.client.Allocations().List((&api.QueryOptions{}).WithContext(ctx))
	if err != nil {
		return nil, fmt.Errorf("list allocations: %w", err)
	}
	prefix := parentJobID + "/dispatch-"
	active := make(map[string]struct{})
	for _, al := range allocs {
		if !strings.HasPrefix(al.JobID, prefix) {
			continue
		}
		if al.ClientStatus == api.AllocClientStatusPending || al.ClientStatus == api.AllocClientStatusRunning {
			active[al.JobID] = struct{}{}
		}
	}
	slots := make([]RunnerSlot, 0, len(active))
	for jobID := range active {
		job, _, err := n.client.Jobs().Info(jobID, (&api.QueryOptions{}).WithContext(ctx))
		if err != nil {
			continue
		}
		slots = append(slots, RunnerSlot{
			RepoURL: metaString(job.Meta, "repo_url"),
			Labels:  metaString(job.Meta, "labels"),
		})
	}
	return slots, nil
}
```

Knowing when a runner is done means checking its allocations. A runner that hasn't been scheduled yet has none, and that counts as not done, so a pending runner is never reaped before it runs:

```go
// RunnerTerminal reports whether a dispatched runner job has finished: every
// allocation is in a terminal client status, or the job is already gone. A job
// with no allocations yet (dispatched but not scheduled) is not terminal, so a
// caller polling this waits for the runner to actually run before reaping --
// never reaping one still pending or mid-job.
func (n *Nomad) RunnerTerminal(ctx context.Context, jobID string) (bool, error) {
	allocs, _, err := n.client.Jobs().Allocations(jobID, false, (&api.QueryOptions{}).WithContext(ctx))
	if err != nil {
		if IsJobNotFound(err) {
			return true, nil
		}
		return false, err
	}
	if len(allocs) == 0 {
		return false, nil
	}
	for _, al := range allocs {
		if al.ClientStatus == api.AllocClientStatusPending || al.ClientStatus == api.AllocClientStatusRunning {
			return false, nil
		}
	}
	return true, nil
}
```

## Finding queued jobs

GitHub has no "list queued jobs" endpoint, so the poller has to build that list itself. It walks the repo's workflow runs that are `queued` or `in_progress`, because a run with several jobs can be in progress while one of its jobs is still waiting, and keeps the jobs that are queued and ask for `self-hosted`. The same job can show up under both run states, so it dedupes by job ID at the end:

```go
func listQueuedSelfHostedJobs(ctx context.Context, cli *github.Client, owner, repo string) ([]QueuedJob, error) {
	var all []QueuedJob
	for _, status := range []string{"queued", "in_progress"} {
		runIDs, err := listWorkflowRunIDs(ctx, cli, owner, repo, status)
		if err != nil {
			return nil, err
		}
		for _, runID := range runIDs {
			jobs, err := queuedSelfHostedJobsForRun(ctx, cli, owner, repo, runID)
			if err != nil {
				return nil, err
			}
			all = append(all, jobs...)
		}
	}
	return dedupByID(all), nil
}
```

```go
// queuedSelfHostedJobsForRun returns runID's jobs that are still queued and ask
// for a self-hosted runner.
func queuedSelfHostedJobsForRun(ctx context.Context, cli *github.Client, owner, repo string, runID int64) ([]QueuedJob, error) {
	opts := &github.ListWorkflowJobsOptions{Filter: "latest", PerPage: 100}
	var jobs []QueuedJob
	for job, err := range cli.Actions.ListWorkflowJobsIter(ctx, owner, repo, runID, opts) {
		if err != nil {
			return nil, fmt.Errorf("list jobs for run %d in %s/%s: %w", runID, owner, repo, err)
		}
		if job.GetStatus() != "queued" || !slices.Contains(job.Labels, selfHostedLabel) {
			continue
		}
		jobs = append(jobs, QueuedJob{
			ID:     job.GetID(),
			RunID:  job.GetRunID(),
			Name:   job.GetName(),
			Labels: job.Labels,
		})
	}
	return jobs, nil
}
```

Forgejo does have an endpoint for a repo's runner jobs, but it has its own catch. A job reports `waiting` from the moment it's created until a runner claims it, and for a moment after the claim the status hasn't caught up yet. Counting that job as queued would dispatch a second runner for work that's already being done, so the Forgejo client also checks whether a task has been assigned:

```go
for _, j := range jobs {
	if !strings.EqualFold(j.Status, statusWaiting) || j.TaskID != 0 {
		continue
	}
	out = append(out, git.QueuedJob{
		ID:     j.ID,
		Name:   j.Name,
		Labels: j.RunsOn,
	})
}
```

## Registering each runner to the right repo

Repos in a personal account can't share self-hosted runners the way repos in a GitHub org can. Each repo needs its own runner registration, so a runner has to be registered to whichever repo queued the job. The scaler does that at dispatch time: it mints a registration token for that repo through a GitHub App installed on all my repos, and passes it to the runner as dispatch meta. Nothing is stored and nothing is set up per repo. Adding a repo to CI is installing the App on it and adding one line to the config below.

The App client itself only ever holds a JWT signed with the App's private key. Every call that touches a repo first mints an installation token scoped to that one repo with the one permission the call needs: `administration: write` to create a registration token, `actions: read` to look at the queue. From the shared GitHub client:

```go
// installationClient mints an installation token scoped to repo with perms and
// returns a token-authenticated client. This is the one place the per-call token
// dance lives (SetRepoSecret and the runner methods all share it); the App
// client itself only ever holds the JWT.
func (g *GitHub) installationClient(ctx context.Context, repo string, perms *github.InstallationPermissions) (*github.Client, error) {
	tok, _, err := g.app.Apps.CreateInstallationToken(ctx, g.instID, &github.InstallationTokenOptions{
		Repositories: []string{repo},
		Permissions:  perms,
	})
	if err != nil {
		return nil, fmt.Errorf("mint installation token for %s: %w", repo, err)
	}
	opts := []github.ClientOptionsFunc{
		github.WithTransport(shared.OTelTransport("github", nil)),
		github.WithAuthToken(tok.GetToken()),
	}
	if g.baseURL != "" {
		opts = append(opts, github.WithEnterpriseURLs(g.baseURL, g.baseURL))
	}
	cli, err := github.NewClient(opts...)
	if err != nil {
		return nil, fmt.Errorf("github token client: %w", err)
	}
	return cli, nil
}

// CreateRunnerRegistrationToken mints a short-lived registration token a runner
// uses to join owner/repo, returning the token and its expiry. Requires the App
// installation to grant administration:write.
func (g *GitHub) CreateRunnerRegistrationToken(ctx context.Context, owner, repo string) (string, time.Time, error) {
	cli, err := g.installationClient(ctx, repo, &github.InstallationPermissions{Administration: new("write")})
	if err != nil {
		return "", time.Time{}, err
	}
	tok, _, err := cli.Actions.CreateRegistrationToken(ctx, owner, repo)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("create runner registration token for %s/%s: %w", owner, repo, err)
	}
	return tok.GetToken(), tok.GetExpiresAt().Time, nil
}
```

The scaler calls this inside the dispatch activity and hands the result straight to Nomad as the `runner_token` meta. Only the dispatched job ID comes back out of the activity, which keeps the token out of Temporal's workflow history (kept for the namespace's retention period and visible in the UI).

Not every repo can use the App. For a repo I'm only a collaborator on, the App can't be installed, so the tokens have to be set up by hand once. I create a low-privilege personal access token for polling, which only needs `Actions: read`. Registering a runner needs admin on the repo, so that token has to come from the owner. Both go into Vault, where the scaler reads the polling token and the dispatched job reads the admin token and registers itself. The higher-privilege token never goes to the scaler. The same code also polls my Forgejo mirror, which mints registration tokens per repo the same way the App does.

The scaler reads its config from one JSON document at `runners/config` in Consul KV. Here is a portion of my Consul KV config:

```json
{
  "afreidah/munchbox": {
    "maxConcurrent": 3,
    "mode": "app"
  },
  "afreidah/nomad-temporal-jobs": {
    "maxConcurrent": 3,
    "mode": "app"
  },
  "alex/s3-orchestrator": {
    "forgejoUrl": "http://forgejo.service.consul:30028",
    "maxConcurrent": 1,
    "mode": "forgejo",
    "profiles": [
      {
        "job": "forgejo-build-runner",
        "label": "build",
        "maxConcurrent": 1
      }
    ],
    "vaultPath": "forgejo/scaler"
  },
  "ev-the-dev/moat": {
    "mode": "vault",
    "profiles": [
      {
        "job": "github-runner-moat-vm",
        "label": "vm",
        "maxConcurrent": 1
      },
      {
        "job": "go-ci-runner",
        "label": "go",
        "maxConcurrent": 3
      },
      {
        "job": "github-runner-moat",
        "label": "moat",
        "maxConcurrent": 2
      }
    ],
    "registerVaultPath": "github/moat-runner",
    "vaultPath": "github/moat-poll"
  }
}
```

Profiles route jobs to different runner pools by their `runs-on` labels, first match wins. A plain `self-hosted` job falls through to the default `ci-runner`. Caps keep a pool from eating the cluster; anything over the cap just waits in GitHub's queue until a slot frees.

## Learning how GitHub assigns jobs to self-hosted runners

My first version tied each runner to a specific queued job. It started one workflow per job and used the job's ID as the workflow's ID, so the same job couldn't be handled twice.

That isn't how GitHub works. You can't control which job a runner picks up. When a repo has several jobs queued with the same labels, GitHub hands a new runner any one of them, not necessarily the one it was started for. So the runner started for the first job could end up running the second. The first job was still waiting, but as far as the scaler knew it had already been handled, and the duplicate check stopped it from starting another runner. That job sat in the queue forever.

The fix was to stop thinking in jobs and reconcile by queue depth. Each tick, the poller groups queued jobs by `(repo, labels)`, counts the runners already pending or running for each group from their Nomad dispatch meta, and starts children only for the difference. If a job gets skipped, it's still queued on the next tick, the count comes up short, and another runner is dispatched. There's no dedup state to get wrong.

Here's that working in the scaler's logs (trimmed to the relevant fields). A job was queued on munchbox, a runner was dispatched for it, and on the next tick the job was still queued because the runner hadn't claimed it yet. The runner already counted as active, so nothing new started:

```text
21:01:01.826  Poll complete                queued=1 active=0 started=1
21:01:02.341  Dispatched ephemeral runner  repo=afreidah/munchbox job=ci-runner labels=[self-hosted] minted=true
21:01:31.853  Poll complete                queued=1 active=1 started=0
21:02:02.026  Poll complete                queued=0 active=0 started=0
21:02:07.465  Runner finished              job=ci-runner/dispatch-1789592462-171d8bee
21:02:07.572  Reaped ephemeral runner      job=ci-runner/dispatch-1789592462-171d8bee
```

The reconcile itself, from `PollAndDispatch`. A bucket key is the repo plus its sorted labels, so a runner's dispatch meta and a queued job's `runs-on` list land in the same bucket regardless of label order:

```go
for _, key := range order {
	b := buckets[key]
	active := activeCounts[key]
	result.QueuedJobs += b.queued
	result.ActiveRunners += active

	// range over a negative shortfall iterates zero times -- an over-covered
	// bucket dispatches nothing.
	needed := b.queued - active
	// Clamp to the pool's concurrency ceiling (profile cap, else the repo-wide
	// cap); overflow stays queued on GitHub.
	rc := repoCfgs[b.repo]
	limit := matchProfile(rc.Profiles, b.labels).MaxConcurrent
	if limit == 0 {
		limit = rc.MaxConcurrent
	}
	if limit > 0 && needed > limit-active {
		needed = limit - active
	}
	for range needed {
		if err := startRunnerChild(ctx, b.repo, b.labels, repoCfgs[b.repo], reapAfter, seq); err != nil {
			logger.Warn("Failed to start runner child", "repo", b.repo, "labels", b.labels, "error", err)
		} else {
			result.RunnersStarted++
		}
		seq++
	}
}
```

## Cleaning up

Each `HandleRunner` child waits for its runner's allocation to finish and then stops the dispatched Nomad job, so dead dispatch jobs don't pile up. The wait has a one-hour ceiling. A runner that wedges or never claims a job is reaped anyway.

Two details matter here. The dispatch activity never retries, because every attempt creates a new runner, and a lost response followed by a retry would start a duplicate. The reap runs on a disconnected context, so it still happens when the workflow is cancelled or times out. The whole child workflow:

```go
func HandleRunner(ctx workflow.Context, spec RunnerSpec) error {
	logger := workflow.GetLogger(ctx)

	// Dispatch must not be retried: it creates a new runner each attempt, so a
	// lost response on retry would spawn a duplicate. The registration token is
	// minted inside the activity, so it never enters workflow history.
	dispatchCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout:    2 * time.Minute,
		ScheduleToCloseTimeout: 2 * time.Minute,
		RetryPolicy:            shared.NoRetry(),
	})
	var dispatchedID string
	err := workflow.ExecuteActivity(dispatchCtx, a.DispatchRunner, activities.DispatchSpec{
		Repo:        spec.Repo,
		Labels:      spec.Labels,
		Job:         spec.Job,
		Image:       spec.Image,
		MintToken:   spec.MintToken,
		VaultSecret: spec.VaultSecret,
		Mode:        spec.Mode,
		ForgejoURL:  spec.ForgejoURL,
		VaultPath:   spec.VaultPath,
	}).Get(dispatchCtx, &dispatchedID)
	if err != nil {
		return fmt.Errorf("dispatch runner for %s: %w", spec.Repo, err)
	}

	reapAfter := spec.ReapAfter
	if reapAfter <= 0 {
		reapAfter = defaultReapAfter
	}
	// Wait until the runner's alloc goes terminal so we reap promptly, with
	// reapAfter as the backstop ceiling (StartToCloseTimeout): a wedged runner
	// times the wait out and we reap anyway. NoRetry -- a timeout means "reap
	// now", not "wait another ceiling". A cancellation (operator terminate) also
	// falls through to the reap below so the dispatched runner is never orphaned.
	waitCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: reapAfter,
		HeartbeatTimeout:    time.Minute,
		RetryPolicy:         shared.NoRetry(),
	})
	if err := workflow.ExecuteActivity(waitCtx, a.WaitRunnerDone, dispatchedID).Get(waitCtx, nil); err != nil {
		logger.Info("Runner wait ended early (backstop deadline or cancellation); reaping now", "job", dispatchedID, "error", err)
	}

	// Reap on a disconnected context so a closing/cancelled workflow can still
	// stop the Nomad job. The reaper treats an already-gone job as success.
	reapCtx, cancel := workflow.NewDisconnectedContext(ctx)
	defer cancel()
	reapCtx = workflow.WithActivityOptions(reapCtx, shared.QuickActivityOptions())
	if err := workflow.ExecuteActivity(reapCtx, a.ReapRunner, dispatchedID).Get(reapCtx, nil); err != nil {
		return fmt.Errorf("reap runner %s: %w", dispatchedID, err)
	}
	return nil
}
```

## What a run looks like

Here's a real tick that found a build queued on the Forgejo mirror of s3-orchestrator. The output is from a small script that reads the workflow's event history with `temporal workflow show` and prints each activity's input and result:

```text
PollAndDispatch  ci-runner-scaler-scheduled-2026-09-25T21:01:00Z
One scheduled tick of the CI runner scaler. It reads the repo list, asks each repo's forge for queued self-hosted jobs, counts the runners already running in Nomad, and starts a runner for every job that isn't covered.
started 2026-09-25T21:01:00Z, took 1.6s

[1] LoadConfig
    Read the per-repo runner config from Consul KV.
    10 repos configured:
      afreidah/munchbox               app      cap 3
      afreidah/nomad-temporal-jobs    app      cap 3
      alex/cloudflare-log-collector   forgejo  cap 1  labels: build
      alex/flight-fetcher             forgejo  cap 1  labels: build
      alex/g3                         forgejo  cap 1  labels: build
      alex/munchbox                   forgejo  cap 2  labels: build, ops, cinc, self-hosted, ubuntu-latest
      alex/nomad-temporal-jobs        forgejo  cap 1  labels: build
      alex/oracle-watchdog            forgejo  cap 1  labels: build
      alex/s3-orchestrator            forgejo  cap 1  labels: build
      ev-the-dev/moat                 vault           labels: vm, go, moat

[2] ListQueuedJobs  x10
    Ask each repo's forge for jobs waiting on a self-hosted runner.
      afreidah/munchbox               app      nothing queued
      afreidah/nomad-temporal-jobs    app      nothing queued
      alex/cloudflare-log-collector   forgejo  nothing queued
      alex/flight-fetcher             forgejo  nothing queued
      alex/g3                         forgejo  nothing queued
      alex/munchbox                   forgejo  nothing queued
      alex/nomad-temporal-jobs        forgejo  nothing queued
      alex/oracle-watchdog            forgejo  nothing queued
      alex/s3-orchestrator            forgejo  1 queued
        - Build and push images  [build]
      ev-the-dev/moat                 vault    nothing queued

[3] CountActiveRunners
    Count runners already pending or running in Nomad, per repo and label set.
    Nomad jobs checked: forgejo-build-runner, forgejo-ci-runner, github-runner-moat-vm, go-ci-runner, github-runner-moat
    no runners active

Runners started: 1
    runner-01a0da5f-1719-759d-8044-6ee6aad20d61-0       alex/s3-orchestrator  [build]
    run temporal-steps <id> to see one runner's dispatch, wait, and reap

Result
    repos scanned: 10   queued jobs: 1   active runners: 0   runners started: 1
```

And the runner it started, from dispatch to cleanup:

```text
HandleRunner  runner-01a0da5f-1719-759d-8044-6ee6aad20d61-0
One ephemeral runner. It dispatches the runner job in Nomad, waits for the runner to finish its CI job, then stops and purges the job.
started 2026-09-25T21:01:01Z, took 125.5s

[1] DispatchRunner
    Mint a registration token (or pass a Vault path) and dispatch one runner job in Nomad.
    repo:    alex/s3-orchestrator
    labels:  build
    job:     forgejo-build-runner
    token:   minted for this runner
    dispatched as forgejo-build-runner/dispatch-1790370061-44e4b15b

[2] WaitRunnerDone
    Wait for the runner's allocation to finish, up to the one-hour ceiling.
    runner: forgejo-build-runner/dispatch-1790370061-44e4b15b
    finished

[3] ReapRunner
    Stop and purge the finished runner job in Nomad.
    stopped and purged forgejo-build-runner/dispatch-1790370061-44e4b15b

Result
    completed
```

The same run from the scaler worker's logs in Nomad, trimmed to the relevant fields. The runner itself leaves no logs behind, because the reap purges its job and Nomad drops the allocation with it:

```text
21:01:00.156  Polling for queued runners
21:01:01.705  Poll complete                queued=1 active=0 started=1
21:01:01.815  Dispatched ephemeral runner  repo=alex/s3-orchestrator job=forgejo-build-runner labels=[build] minted=true
                                           dispatched=forgejo-build-runner/dispatch-1790370061-44e4b15b
21:01:31.543  Poll complete                queued=0 active=0 started=0
21:02:01.466  Poll complete                queued=0 active=0 started=0
21:02:31.421  Poll complete                queued=0 active=0 started=0
21:03:01.586  Poll complete                queued=0 active=0 started=0
21:03:06.986  Runner finished              job=forgejo-build-runner/dispatch-1790370061-44e4b15b
21:03:07.086  Reaped ephemeral runner      job=forgejo-build-runner/dispatch-1790370061-44e4b15b
```

The Temporal web UI shows the same thing graphically. These two screenshots are from an earlier build on the same repo, at 20:31.

First the tick. The top of the page is the workflow's input (the scan concurrency) and its result, which says it scanned 10 repos, found 1 queued job, and started 1 runner. The timeline under it has one bar per activity. `CountActiveRunners` is selected, so the panel at the bottom shows how Temporal ran that step: its timeouts, its retry policy (up to 3 attempts, backing off from 1 second), and its input, which is the list of Nomad runner jobs it checked. The `HandleRunner` marker at the right edge of the timeline is the child workflow the tick started for the queued build.

![Temporal UI timeline for a PollAndDispatch tick that found one queued job and started one runner](/images/posts/ci-runners/poll-and-dispatch-timeline.png "A PollAndDispatch tick: the result at the top right, the activity timeline in the middle, and the selected `CountActiveRunners` step with its retry policy and input at the bottom.")

Then that child. Its input is the spec the tick handed it: the repo, the `build` label, which Nomad job to dispatch, and that it should mint a token against the Forgejo instance. The timeline shows the whole life of the runner. `DispatchRunner` is the short bar at the very start, `WaitRunnerDone` runs for the two minutes the build took, and `ReapRunner` is the short bar at the end once the runner exited.

![Temporal UI timeline for a HandleRunner child showing dispatch, a two-minute wait, and reap](/images/posts/ci-runners/handle-runner-timeline.png "One HandleRunner child: the runner spec as input, then dispatch, a two-minute wait while the build ran, and the reap.")

## Why Temporal

Mostly because it was already there. Temporal was running my backups and maintenance, and nomad-temporal-jobs already had shared client libraries for Nomad, Consul, Vault, and GitHub. The scaler needed exactly those four, so it was a natural extension: a new worker built out of clients I was already using. The scaler's entire `main()` is wiring those clients together and registering two workflows:

```go
func main() {
	err := shared.RunWorker(context.Background(), shared.WorkerSpec{
		Service:   "ci-runner-scaler",
		TaskQueue: "ci-runner-scaler-task-queue",
		Register: func(ctx context.Context, slogger *slog.Logger, w worker.Worker) (func(), error) {
			// Vault (Workload Identity); the GitHub App key is pulled through it,
			// so the Nomad job carries only its identity.
			vc, err := vault.NewVaultWithRefresher(ctx, slogger)
			if err != nil {
				return nil, err
			}
			// Reuses the token-renewer App (also needs Administration + Actions perms).
			appPath := cmp.Or(os.Getenv("GITHUB_APP_VAULT_PATH"), "github/token-renewer-app")
			gh, err := git.NewGitHubFromVault(ctx, vc, appPath)
			if err != nil {
				return nil, err
			}
			// Consul KV (per-repo runner config) uses the local agent's default
			// ACL token over host networking -- no per-worker Consul token.
			kv, err := consul.NewConsul(ctx, nil)
			if err != nil {
				return nil, err
			}
			nm, err := nomad.NewNomad()
			if err != nil {
				return nil, err
			}

			// Vault doubles as the vault-mode PAT source: repos the App can't reach
			// carry a runner token in the secret store, read per poll via ReadKV.
			// The default NewPATLister (git.NewGitHubPAT) is left in place.
			acts := activities.New(activities.Config{
				GitHub:      gh,
				KV:          kv,
				Nomad:       nm,
				Vault:       vc,
				ConfigKey:   os.Getenv("RUNNERS_CONFIG_KEY"),
				RunnerJobID: os.Getenv("RUNNER_JOB_ID"),
			})
			w.RegisterWorkflow(workflows.PollAndDispatch)
			w.RegisterWorkflow(workflows.HandleRunner)
			w.RegisterActivity(acts)
			return nil, nil
		},
	})
	if err != nil {
		log.Fatalln(err)
	}
}
```

`shared.RunWorker` handles the rest that every worker in the repo needs: tracing, structured logging, Prometheus metrics, and the Temporal client.

It also fits the problem. Each runner gets its own child workflow, so its state, its one-hour ceiling, and its cleanup survive a worker restart without me storing anything. Retries are set per step: polling retries, dispatch never does, and the reap runs even if the workflow is cancelled.

## The code

The scaler lives in [nomad-temporal-jobs/runnerscaler](https://github.com/afreidah/nomad-temporal-jobs/tree/main/runnerscaler), next to the other workers in that repo. The [project page](https://nomad-temporal-jobs.munchbox.cc) covers all of them, including backups, image scanning, and cluster maintenance. The Nomad job files and the Consul KV config are in [munchbox](https://github.com/afreidah/munchbox).
