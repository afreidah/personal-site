---
title: "Rolling Nomad, Consul and Vault Upgrades"
date: 2026-10-01
description: "A tool that surveys a cluster, writes a gated run file, and drives it host by host through Cinc. The file is the journal, so a run that stops resumes by naming it again."
links:
  - { label: "Source on GitHub", url: "https://github.com/afreidah/munchbox-hashi-upgrade" }
  - { label: "Design doc", url: "https://github.com/afreidah/munchbox-hashi-upgrade/blob/main/docs/design.md" }
  - { label: "Cinc cookbooks", url: "https://github.com/afreidah/munchbox/tree/main/infrastructure/cinc/cookbooks" }
---

Seventeen hosts in my cluster run Consul, twelve run Nomad, three run Vault. Upgrading any of them follows the same rules. Servers tolerate running ahead of clients, not the reverse. One server goes down at a time, and only while the rest can still coordinate. The host that coordinates hands that off deliberately rather than by going away.

My binaries are installed by configuration management. A version pin lives in a `versions` data bag, read by a [small library](https://github.com/afreidah/munchbox/blob/main/infrastructure/cinc/cookbooks/munchbox_lib/libraries/pinned_version.rb) that every tool's cookbook calls, and each host's `cinc-client` run installs whatever the pin says. The [`consul`](https://github.com/afreidah/munchbox/tree/main/infrastructure/cinc/cookbooks/consul), [`nomad`](https://github.com/afreidah/munchbox/tree/main/infrastructure/cinc/cookbooks/nomad) and [`vault`](https://github.com/afreidah/munchbox/tree/main/infrastructure/cinc/cookbooks/vault) cookbooks all resolve their version the same way:

```ruby
vault_install 'vault' do
  version    pinned_version(cookbook)
  bin_path   node[cookbook]['install']['bin_path']
  ...
end
```

An upgrade is therefore not a binary push. It is: stop the scheduled converges, move the pin, converge the hosts in the right order, and check the cluster between each one.

This tool is that sequence.

## Three commands

`plan` reads the cluster and writes a run file. It changes nothing: no pin, no timer, no host. Everything that alters anything is a task in the file it produces.

`run` carries out a run file, recording the outcome of every task back into it. It resumes, so a run that stopped is continued by naming the same file.

`status` reads a run file and reports it. No cluster, no credentials, no change. A run that stopped overnight gets read before deciding what to do about it, and reading it should not require the ability to act on it.

```
hashi-upgrade plan consul --to 2.0.4
hashi-upgrade run consul-munchbox-20261001T062815Z.yaml
hashi-upgrade status consul-munchbox-20261001T062815Z.yaml
```

## Task order

<pre class="diagram"><span class="hl">survey</span>   freeze-converge         stop the scheduled converges fleet-wide
         set-version-pin         move the pin every converge will read

<span class="hl">servers</span>  upgrade-member          each non-coordinating host in turn
         hand-off-coordination   move coordination off the last one
         upgrade-member          that host, last

<span class="hl">clients</span>  upgrade-member          each host that carries work, in turn

<span class="hl">verify</span>   verify-cluster          read the fleet back against the target
         thaw-converge           release the scheduled converges
</pre>

The timers stop before the pin moves. A scheduled converge landing between the two installs the new version on a host the run has not reached, out of order and unobserved.

The pin moves once, centrally, before any host is touched, so hosts differ only in when they are converged and never in what they converge toward.

The coordinating host goes last, so the cluster spends most of the server stage with settled coordination.

Verification runs before the timers come back. The per-host gates each proved one host returned, which is not the same as the fleet having arrived: a host the survey missed, or one whose converge was a no-op because the pin never reached it, passes every gate and still runs the old binary.

A plan against my Consul datacenter (and yes, all the bare-metal nodes are named after Law & Order characters):

```text
munchbox: 17 hosts, 1 server failure tolerated
upgrading consul to 2.0.4

servers
  goren            2.0.3
  nomad-server-03  2.0.3     coordinating
  stabler          2.0.4     already at 2.0.4
clients
  cabot            2.0.3
  fontana          2.0.3
  mccoy            2.0.3
  rubirosa         2.0.3
  ...

survey
  Stop scheduled converges across the fleet  [prompt]
  Pin consul to 2.0.4  [typed]
servers
  Upgrade goren to 2.0.4  [prompt, point of no return]
  Upgrade stabler to 2.0.4  [prompt]
  Hand coordination off nomad-server-03  [typed]
  Upgrade nomad-server-03 to 2.0.4  [typed]
clients
  Upgrade cabot to 2.0.4  [prompt]
  Upgrade fontana to 2.0.4  [prompt]
  Upgrade mccoy to 2.0.4  [prompt]
  Upgrade rubirosa to 2.0.4  [prompt]
  ...
verify
  Confirm the fleet is running 2.0.4
  Restore scheduled converges across the fleet
```

Confirmations are recorded in the file rather than decided by the runner when it reaches them, so which boundaries stop for a person can be reviewed in advance. Two strengths: `prompt` for anything worth pausing on, and `typed` for moving coordination and restarting the host that had it. Typed asks for the host's name back.

`stabler` is marked `already at 2.0.4` from an earlier failed attempt. Its task still appears and settles as `unnecessary` when the run reaches it.

## What a survey reads

Topology is never declared. Each tool is asked, and the answer is two reads that have to be matched up.

<svg class="flow" width="1120" height="330" style="display:block;max-width:100%;height:auto;margin:28px 0 32px" viewBox="0 0 1120 330" role="img" aria-labelledby="nm-t nm-d" xmlns="http://www.w3.org/2000/svg">
  <title id="nm-t">What a Nomad survey reads</title>
  <desc id="nm-d">Two reads. Autopilot health describes the three servers with each one's version, leader flag and voter standing. The node list describes the eleven hosts registered to run work. They are reconciled on advertise address rather than on name, because the two reads disagree about name shape. Two hosts appear in both lists and are recorded once, as servers, because each carries one binary and one service. The survey is twelve hosts: three servers and nine clients.</desc>
  <style>
    .flow text { font-family: inherit; }
    .flow .lbl   { font-size: 14.5px; font-weight: 600; fill: var(--fg); }
    .flow .sub   { font-size: 12.5px; fill: var(--muted); }
    .flow .mono  { font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; fill: var(--fg); }
    .flow .micro { font-size: 11.5px; font-weight: 700; fill: var(--accent); letter-spacing: .07em; }
    .flow .box   { fill: var(--card); stroke: var(--border); stroke-width: 1.5; }
    .flow .ok    { fill: var(--card); stroke: var(--accent); stroke-width: 1.5; }
    .flow .ln    { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  </style>
  <defs>
    <marker id="na" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0l10 5-10 5z" fill="var(--accent)"/>
    </marker>
  </defs>
  <text x="24" y="20" class="micro">TWO READS</text>
  <rect x="24" y="34" width="322" height="104" rx="12" class="ok"/>
  <text x="42" y="58" class="mono">/v1/operator/autopilot/health</text>
  <text x="42" y="78" class="sub">version, leader, voter, healthy</text>
  <text x="42" y="104" class="mono">goren  nomad-server-03  stabler</text>
  <text x="42" y="126" class="sub">3 servers</text>
  <rect x="24" y="162" width="322" height="128" rx="12" class="ok"/>
  <text x="42" y="186" class="mono">/v1/nodes</text>
  <text x="42" y="206" class="sub">everything registered to run work</text>
  <text x="42" y="232" class="mono">goren  stabler</text>
  <text x="42" y="252" class="mono">nomad-client-01..05</text>
  <text x="42" y="272" class="mono">oraclearm1/2  oraclenode1/2</text>
  <text x="250" y="186" class="sub">11 registered</text>
  <path class="ln" marker-end="url(#na)" d="M346 86H400V142H444"/>
  <path class="ln" marker-end="url(#na)" d="M346 226H400V170H444"/>
  <rect x="444" y="124" width="216" height="64" rx="12" class="box"/>
  <text x="552" y="150" text-anchor="middle" class="lbl">reconcile</text>
  <text x="552" y="172" text-anchor="middle" class="sub">on advertise address</text>
  <path class="ln" marker-end="url(#na)" d="M660 156H714"/>
  <rect x="714" y="56" width="382" height="200" rx="12" class="ok"/>
  <text x="734" y="84" class="lbl">12 hosts: 3 servers, 9 clients</text>
  <text x="734" y="112" class="sub">goren and stabler run a server and a client</text>
  <text x="734" y="132" class="sub">each. Each is recorded once, as a server:</text>
  <text x="734" y="152" class="sub">one binary, one service, upgraded once.</text>
  <text x="734" y="186" class="sub">Name is no good for matching the two</text>
  <text x="734" y="206" class="sub">lists. Nomad calls a host oraclearm1;</text>
  <text x="734" y="226" class="sub">Consul calls the same host oracle-arm-1.</text>
</svg>

The two lists overlap. `goren` and `stabler` each run a Nomad server and a Nomad client, and a host like that is recorded once, as a server, because it carries one binary and one service. Upgrading it twice would restart one raft member twice and spend the cluster's fault tolerance twice for one host.

They are matched on advertise address rather than on name, because the two reads do not agree on name shape.

## Gate conditions

A converge exiting zero does not mean the host is back. The gate after each host polls the cluster until the cluster says so:

```go
func (g *Gate) Server(ctx context.Context, name, target string) error {
	what := fmt.Sprintf("%s rejoining the cluster at %s", name, target)
	arrived := fmt.Sprintf("%s is running %s, healthy, and back in the cluster", name, target)

	return g.await(ctx, what, arrived, func(cluster plan.Cluster) error {
		m, err := member(cluster, name)
		if err != nil {
			return err
		}

		switch {
		case m.Version != target:
			return fmt.Errorf("%s is running %s, not %s", name, m.Version, target)
		case !m.Healthy:
			return fmt.Errorf("%s is not healthy", name)
		// Asked only where coordination runs on a quorum of these members. A
		// cluster whose quorum lives in its storage backend has no voters at
		// all, and requiring one would hold every host here until it timed out.
		case cluster.Votes() && !m.Voter:
			return fmt.Errorf("%s is not a voter", name)
		case !cluster.Healthy:
			return fmt.Errorf("%s rejoined but the cluster is not healthy", name)
		case cluster.Tolerance < minTolerance:
			return fmt.Errorf("failure tolerance is %d, want at least %d", cluster.Tolerance, minTolerance)
		}

		return nil
	})
}
```

The version proves the host restarted, read from the running agent rather than from the pin. A host that was never restarted reports the old version however healthy it looks.

A timeout carries the condition it gave up on rather than only its duration. "Waited ten minutes" gives nothing to act on; "spent them waiting for `cinc-server` at 2.0.4, and it is running 2.0.3" identifies the host and the check.

## Adding Consul

Consul's autopilot answers in the same shape as Nomad's: healthy, failure tolerance, and a server row carrying version, leader, voter and raft ID. The snapshot a run is generated against is built the same way, and everything downstream is shared without modification: the run file, the runner, the step table, the gates, all three commands.

<svg class="flow" width="1120" height="330" style="display:block;max-width:100%;height:auto;margin:28px 0 32px" viewBox="0 0 1120 330" role="img" aria-labelledby="cs-t cs-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cs-t">What a Consul survey reads</title>
  <desc id="cs-d">Two reads, in the same shape as Nomad's. Autopilot health describes the three servers. The gossip pool lists every agent in the datacenter, servers included, with each one's version in its build tag. They are reconciled on name, and an agent already recorded as a server is skipped so that no host is upgraded twice. The survey is seventeen hosts: three servers and fourteen agents, five of which run no Nomad at all.</desc>
  <style>
    .flow text { font-family: inherit; }
    .flow .lbl   { font-size: 14.5px; font-weight: 600; fill: var(--fg); }
    .flow .sub   { font-size: 12.5px; fill: var(--muted); }
    .flow .mono  { font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; fill: var(--fg); }
    .flow .micro { font-size: 11.5px; font-weight: 700; fill: var(--accent); letter-spacing: .07em; }
    .flow .box   { fill: var(--card); stroke: var(--border); stroke-width: 1.5; }
    .flow .ok    { fill: var(--card); stroke: var(--accent); stroke-width: 1.5; }
    .flow .ln    { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  </style>
  <defs>
    <marker id="ca" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0l10 5-10 5z" fill="var(--accent)"/>
    </marker>
  </defs>
  <text x="24" y="20" class="micro">TWO READS, THE SAME SHAPE</text>
  <rect x="24" y="34" width="322" height="104" rx="12" class="ok"/>
  <text x="42" y="58" class="mono">/v1/operator/autopilot/health</text>
  <text x="42" y="78" class="sub">version, leader, voter, healthy</text>
  <text x="42" y="104" class="mono">goren  nomad-server-03  stabler</text>
  <text x="42" y="126" class="sub">3 servers</text>
  <rect x="24" y="162" width="322" height="128" rx="12" class="ok"/>
  <text x="42" y="186" class="mono">/v1/agent/members</text>
  <text x="42" y="206" class="sub">every agent, servers included</text>
  <text x="250" y="186" class="sub">17 in the pool</text>
  <text x="42" y="232" class="mono">cabot  fontana  mccoy  rubirosa</text>
  <text x="42" y="252" class="mono">cinc-server  nomad-client-01..05</text>
  <text x="42" y="272" class="mono">oracle-arm-1/2  oracle-node-1/2</text>
  <path class="ln" marker-end="url(#ca)" d="M346 86H400V142H444"/>
  <path class="ln" marker-end="url(#ca)" d="M346 226H400V170H444"/>
  <rect x="444" y="124" width="216" height="64" rx="12" class="box"/>
  <text x="552" y="150" text-anchor="middle" class="lbl">reconcile</text>
  <text x="552" y="172" text-anchor="middle" class="sub">on name</text>
  <path class="ln" marker-end="url(#ca)" d="M660 156H714"/>
  <rect x="714" y="56" width="382" height="200" rx="12" class="ok"/>
  <text x="734" y="84" class="lbl">17 hosts: 3 servers, 14 agents</text>
  <text x="734" y="112" class="sub">The gossip pool lists the servers too, so an</text>
  <text x="734" y="132" class="sub">agent already recorded as a server is</text>
  <text x="734" y="152" class="sub">skipped. A version comes out of the build</text>
  <text x="734" y="172" class="sub">tag a member carries.</text>
  <text x="734" y="206" class="sub">Five of these run no Nomad: the four</text>
  <text x="734" y="226" class="sub">Proxmox hypervisors and the Cinc server.</text>
</svg>

What is new per tool is one client package and a case here:

```go
// For returns the client for a tool.
//
// A tool with no client is refused by name rather than attempted, so it fails
// here with something to read instead of somewhere deeper holding a nil.
func For(tool plan.Tool, opts Options) (Cluster, error) {
	switch tool {
	case plan.Nomad:
		return nomad.New(nomad.Options{Address: opts.Address, Region: opts.Region})
	case plan.Consul:
		return consul.New(consul.Options{Address: opts.Address})
	case plan.Vault:
		return vault.New(vault.Options{Address: opts.Address})
	default:
		return nil, fmt.Errorf("unknown tool %q; expected nomad, consul or vault", tool)
	}
}
```

Capabilities that not every tool has stay off the shared interface. Nomad is the only one that places work, so a client able to drain a host implements `execute.Drainer` and is asked for it at the point of use. The `--drain` flag is dropped at plan time for a tool that schedules nothing, rather than recorded in the file and ignored.

## Vault with Consul storage

My Vault cluster keeps its data in Consul rather than in integrated raft storage, which changes what a survey can read.

There is no raft, so `sys/storage/raft/autopilot/state` does not exist. There is no failure tolerance to read, no stabilisation timestamp, and no voters. Every node is a standby contending for a lock, and `vault operator raft list-peers` returns `No raft cluster configuration found`.

The survey reads `sys/ha-status`, which lists the HA set from the active node's view. Failure tolerance is derived rather than read: the cluster serves while one node is unsealed and one is active, so what it can afford to lose is every serving node but one.

Voting needed a decision. Treating "Vault does not vote" as a per-tool fact would be wrong, because the same Vault on integrated raft storage does vote. Whether coordination runs on a quorum of the cluster's own members describes the deployment, not the tool, so it is read from the members:

```go
// Votes is whether coordination in this cluster runs on a quorum of its own
// members.
//
// Read from the cluster rather than decided by the tool, because it is a
// property of how the cluster is deployed and not of what it is. A Vault
// cluster keeping its data in Consul has no voters; the same Vault with
// integrated raft storage does. Asking the members means neither case has to
// be configured, and a cluster that is migrated between them is read correctly
// without being told.
//
// One host mid-restart has dropped out of its quorum while its peers have not,
// so any voter makes this a voting cluster.
func (c Cluster) Votes() bool {
	for _, m := range c.Members {
		if m.Voter {
			return true
		}
	}
	return false
}
```

Migrating Vault to raft storage later requires no change here.

Restarting a Vault node leaves it sealed until the KMS unseals it. `sys/ha-status` does not report that, so each node is also asked `sys/health` at its own address, which does. A sealed node then counts as unhealthy, and a gate waiting on one says it is sealed rather than blaming the version.

## Test environments

Each tool has a Docker Compose environment: three servers and two clients for Nomad and Consul, three servers for Vault. Each starts a release behind the version to plan toward, since a fleet already at the target plans a run whose every task is a no-op.

The hosts carry stand-ins for the two things a container does not have: a `systemctl` that answers the timer commands, and a `cinc-client` that reads the pin and installs it. That covers the orchestration around a converge. Whether a cookbook installs Consul correctly belongs to [the cookbook](https://github.com/afreidah/munchbox/tree/main/infrastructure/cinc/cookbooks/consul), which is tested on its own.

The Vault environment runs two services that are not part of the fleet being upgraded: a Consul for storage, and a second Vault serving a transit key in place of a cloud KMS, so a restarted node returns unsealed without intervention. A Vault cluster without automatic unsealing cannot be rolled unattended at all.

Four faults found in these environments:

**An unhealthy cluster read as healthy.** Nomad's autopilot reports one as HTTP 429 carrying the health reply, and the API client treats every non-2xx as an error and discards the body. `Cluster.Healthy` could only ever be true, so every gate reading it was checking nothing.

**The server gate waited on a timestamp that does not move.** An agent that goes down and comes back inside one health interval is never seen unhealthy. `StableSince` therefore still reads from before the restart, and the gate cannot pass a host that has already arrived.

**A failed converge was taken as success.** `Converge` returns a non-zero exit as a result rather than an error, since the command reached the host and reported. The caller discarded it. So a `cinc-client` that exited 1 counted as done. The run moved on to a gate waiting for a host nothing had installed anything on, timed out there, and reported a version mismatch.

**A voter was required in a cluster where nothing votes.** Two sites. The gate above is one. The other is choosing which host coordination is handed to, which fails later: after two of three servers are upgraded, at the step marked as the point of no return.

```text
Hand coordination off vault-server-1
unwinding: releasing the converge timers
hand-off-coordination: no healthy voter can take coordination from vault-server-1;
  unfit: [vault-server-2 vault-server-3]
```

Both sites now call `Cluster.Votes()` first.

## Two faults found in production

**Gates gave up after three minutes.** A converge installs a couple of hundred megabytes, restarts a service and rejoins a cluster. One host took 3m20s. A gate that gives up inside that fails a run that was going to succeed, and leaves the operator to determine whether the host is wrong or slow. The default is ten minutes.

**The pin rolled itself back.** Two separate decisions combined into a state with no recovery path.

The pin step recorded a compensation that restored whatever version it found. The reasoning was that an unwinding run turns the converge timers back on. Leaving the pin at the new version would then have every host converge to it unattended, which is what freezing the timers before pinning exists to prevent.

Separately, a resumed run does not repeat a task that already succeeded.

During a 17-host Consul run I left a confirmation prompt unanswered. The run failed, unwound, and restored the pin to 2.0.3.

On restart, the pin step was already recorded as succeeded, so it was skipped. Three hosts then converged onto 2.0.3, the version the fleet was being upgraded away from, and sat at gates waiting for a 2.0.4 that was never coming. Recovering meant editing the data bag by hand.

The fix was to stop treating the pin as a reversible side effect. It is the run's intent. Converges are frozen for the whole run, so nothing reads the pin until the run ends and leaving it set costs nothing. Rolling it back costs twice: a fleet half-converged onto the new version and aimed at the old one converges backwards once the timers return, and a resume cannot repair it.

Two tests had encoded the old behaviour.

## Run output

Vault, 2.0.4 to 2.1.1, against the container fleet:

```text
Stop scheduled converges across the fleet
Pin vault to 2.1.1
Upgrade vault-server-2 to 2.1.1
  vault-server-2 | [cinc-client] reading the pin from http://cinc-server:8889/organizations/test
  vault-server-2 | [cinc-client] pinned 2.1.1, running 2.0.4
  vault-server-2 | [cinc-client] fetching https://releases.hashicorp.com/vault/2.1.1/vault_2.1.1_linux_amd64.zip (168 MB)
  vault-server-2 | [cinc-client] downloaded in 4s
  vault-server-2 | [cinc-client] installed Vault v2.1.1
  vault-server-2 | [cinc-client] restarting the agent
  vault-server-2 | [cinc-client] converge complete
  waiting for vault-server-2 rejoining the cluster at 2.1.1
    vault-server-2 is running 2.0.4, not 2.1.1
    vault-server-2 is running 2.1.1, healthy, and back in the cluster (4s)
Upgrade vault-server-3 to 2.1.1
  ...
  waiting for vault-server-3 rejoining the cluster at 2.1.1
    vault-server-3 is running 2.0.4, not 2.1.1
    vault-server-3 is running 2.1.1, healthy, and back in the cluster (13s)
Hand coordination off vault-server-1
  waiting for coordination moving off vault-server-1
    vault-server-1 is no longer coordinating (2s)
Upgrade vault-server-1 to 2.1.1
  ...
  waiting for vault-server-1 rejoining the cluster at 2.1.1
    vault-server-1 is running 2.1.1, healthy, and back in the cluster (4s)
Confirm the fleet is running 2.1.1
Restore scheduled converges across the fleet

every host is on vault 2.1.1
```

Each gate reports the condition not yet met, then the fact that it now is, with how long it took. `vault-server-2 is running 2.0.4, not 2.1.1` is the gate observing a host that has not come back yet.

The download size and timing are printed because `curl` is silent while it works. The first version printed `fetching` and then nothing for a minute, which on a cold run is indistinguishable from a hang. I interrupted a working run on that basis.

## Resuming

<svg class="flow" width="1120" height="500" style="display:block;max-width:100%;height:auto;margin:28px 0 32px" viewBox="0 0 1120 500" role="img" aria-labelledby="rf-t rf-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rf-t">A task's states in the run file</title>
  <desc id="rf-d">Every task starts as waiting. The run marks it active when it begins it, and the file is rewritten at that point, so a run that dies mid-task leaves the task active. A task that finishes becomes succeeded, or unnecessary if the host was already at the target, or failed if it reported an error. Succeeded and unnecessary are settled, so a resumed run moves past them. Failed and active are not settled, and a resumed run stops on them, because whether the work took effect is unknown. Recovery is to read the status, look at the host, and reset that task, which returns it to waiting.</desc>
  <style>
    .flow text { font-family: inherit; }
    .flow .lbl   { font-size: 15px; font-weight: 600; fill: var(--fg); }
    .flow .sub   { font-size: 12.5px; fill: var(--muted); }
    .flow .micro { font-size: 11.5px; font-weight: 700; fill: var(--accent); letter-spacing: .07em; }
    .flow .mred  { font-size: 11.5px; font-weight: 700; fill: var(--accent-red); letter-spacing: .07em; }
    .flow .box   { fill: var(--card); stroke: var(--border); stroke-width: 1.5; }
    .flow .ok    { fill: var(--card); stroke: var(--accent); stroke-width: 1.5; }
    .flow .stop  { fill: var(--card); stroke: var(--accent-red); stroke-width: 1.5; }
    .flow .ln    { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .flow .ln-r  { fill: none; stroke: var(--accent-red); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .flow .ln-m  { fill: none; stroke: var(--muted); stroke-width: 1.75; stroke-dasharray: 6 5; stroke-linecap: round; stroke-linejoin: round; }
  </style>
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0l10 5-10 5z" fill="var(--accent)"/>
    </marker>
    <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0l10 5-10 5z" fill="var(--accent-red)"/>
    </marker>
    <marker id="am" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0l10 5-10 5z" fill="var(--muted)"/>
    </marker>
  </defs>
  <!-- waiting -> active -->
  <rect x="24" y="150" width="186" height="64" rx="12" class="box"/>
  <rect x="286" y="150" width="206" height="64" rx="12" class="stop"/>
  <path class="ln" marker-end="url(#a)" d="M210 182H286"/>
  <text x="248" y="172" text-anchor="middle" class="sub">starts</text>
  <g text-anchor="middle">
    <text x="117" y="178" class="lbl">waiting</text>
    <text x="117" y="198" class="sub">not reached</text>
    <text x="389" y="178" class="lbl">active</text>
    <text x="389" y="198" class="sub">started, no result yet</text>
  </g>
  <!-- the file is written here -->
  <path class="ln-m" marker-end="url(#am)" d="M389 150V118"/>
  <text x="389" y="90" text-anchor="middle" class="sub">the file is rewritten here, so a run</text>
  <text x="389" y="108" text-anchor="middle" class="sub">that dies mid-task leaves it active</text>
  <!-- active -> three outcomes -->
  <path class="ln" marker-end="url(#a)" d="M492 182H540V92H600"/>
  <path class="ln" marker-end="url(#a)" d="M492 182H600"/>
  <path class="ln-r" marker-end="url(#ar)" d="M492 182H540V292H600"/>
  <rect x="600" y="64" width="212" height="56" rx="12" class="ok"/>
  <rect x="600" y="154" width="212" height="56" rx="12" class="ok"/>
  <rect x="600" y="264" width="212" height="56" rx="12" class="stop"/>
  <g text-anchor="middle">
    <text x="706" y="88" class="lbl">succeeded</text>
    <text x="706" y="107" class="sub">done</text>
    <text x="706" y="178" class="lbl">unnecessary</text>
    <text x="706" y="197" class="sub">already at the target</text>
    <text x="706" y="288" class="lbl">failed</text>
    <text x="706" y="307" class="sub">reported an error</text>
  </g>
  <!-- verdicts -->
  <path class="ln" d="M812 92H856V182H812"/>
  <path class="ln" marker-end="url(#a)" d="M856 137H904"/>
  <text x="914" y="132" class="micro">SETTLED</text>
  <text x="914" y="152" class="sub">a resume moves past it</text>
  <path class="ln-r" marker-end="url(#ar)" d="M812 292H904"/>
  <text x="914" y="287" class="mred">NOT SETTLED</text>
  <text x="914" y="307" class="sub">a resume stops here</text>
  <path class="ln-r" d="M389 214V360H880V300"/>
  <text x="560" y="378" text-anchor="middle" class="sub">active is not settled either: whether the work took effect is what is unknown</text>
  <!-- recovery -->
  <text x="24" y="416" class="micro">RECOVERY - AN OPERATOR NAMES THE TASK</text>
  <rect x="24" y="428" width="196" height="56" rx="12" class="box"/>
  <rect x="244" y="428" width="196" height="56" rx="12" class="box"/>
  <rect x="464" y="428" width="196" height="56" rx="12" class="box"/>
  <path class="ln" marker-end="url(#a)" d="M220 456H244"/>
  <path class="ln" marker-end="url(#a)" d="M440 456H464"/>
  <g text-anchor="middle">
    <text x="122" y="452" class="lbl">status</text>
    <text x="122" y="471" class="sub">which task, and why</text>
    <text x="342" y="452" class="lbl">look at the host</text>
    <text x="342" y="471" class="sub">outside the tool</text>
    <text x="562" y="452" class="lbl">run &#45;&#45;reset</text>
    <text x="562" y="471" class="sub">forgets that record</text>
  </g>
  <path class="ln-m" marker-end="url(#am)" d="M660 456H700V398H117V220"/>
  <text x="712" y="451" class="sub">the task returns to waiting,</text>
  <text x="712" y="469" class="sub">and the run reaches it again</text>
</svg>

Two outcomes do not settle: `failed`, where the task reported an error, and `active`, where it started and never reported back, which is what an interrupt leaves behind. Neither is stepped over on resume, because whether the work took effect is what is unknown.

```text
stopped: upgrade-cinc-server is active

check the host, then: run consul-munchbox-20261001T055728Z.yaml --reset upgrade-cinc-server
```

The run does not decide on its own that a half-done converge is safe to repeat. Naming the task explicitly, after looking at the host, is what distinguishes a retry from a guess.

## Production runs

All three tools have been driven against production: Nomad 2.0.5 to 2.0.7 across 12 hosts, Consul 2.0.3 to 2.0.4 across 17, Vault 2.0.4 to 2.1.1 across 3.

The Consul run exercised the most, since it touches five hosts Nomad does not: the Proxmox hypervisors and the Cinc server. It failed immediately on the Cinc server:

```text
freeze-converge-timers: ssh dial 192.168.68.99:22 as root:
  ssh: handshake failed: ssh: non-certificate host key
```

The tool verifies host keys against a CA and refuses a bare one. That host was presenting a bare key, with its signed certificate sitting unused on disk, because its role was missing the `sshd_ca` recipe every other node role carries. One line in a role file. Only a run that dialled every host was going to surface it.

A preflight script exists for exactly this, and it missed it. The script shells out to `ssh`, which was happy to trust a `known_hosts` entry. It checks reachability, not the credentials a run actually uses. That gap is still open.

## The code

The tool is at [munchbox-hashi-upgrade](https://github.com/afreidah/munchbox-hashi-upgrade). The design document in that repository covers the sequence, what each tool does differently, and the full list of faults found so far.

Three things are still open. The integration tier covers Nomad only, so the handoff and the coordination gate have no automated test against a real election; they are covered by container fleets driven by hand and by the production runs. A cluster-level barrier between hosts is written and tested, but no step calls it yet. Draining a client before restarting it is implemented and off by default, and has never run against a production fleet.
