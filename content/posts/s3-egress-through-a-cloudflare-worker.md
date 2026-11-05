---
title: "Routing S3 Egress Through a Cloudflare Worker"
date: 2026-11-05
description: "An overview of routing S3 reads through a Cloudflare Worker to avoid egress charges, and how I set it up for three storage providers."
draft: true
links:
  - { label: "Guide", url: "https://s3-orchestrator.munchbox.cc/guides/cloudflare-edge-proxy/" }
  - { label: "Worker source", url: "https://github.com/afreidah/s3-orchestrator/tree/main/deploy/cloudflare-worker" }
  - { label: "Terragrunt", url: "https://github.com/afreidah/munchbox/blob/main/infrastructure/terragrunt/_env_helpers/cloudflare-worker-routes.hcl" }
---

[s3-orchestrator](https://s3-orchestrator.munchbox.cc/) is a service I wrote that stores my files across twelve storage providers, most of them on free tiers. Providers limit **egress**, which is data leaving their network, and every read from a provider counts as egress.

Backblaze B2, IBM Cloud and Oracle Cloud are members of Cloudflare's [Bandwidth Alliance](https://www.cloudflare.com/bandwidth-alliance/), a group of cloud providers that discount or waive data transfer fees on traffic going to Cloudflare. These three don't bill egress on that traffic. To use that, each of those buckets sits behind a Cloudflare Worker, so reads leave the provider to Cloudflare.

## Proxied DNS records and S3 signatures

Pointing a proxied Cloudflare hostname like `b2-proxy.munchbox.cc` at a bucket doesn't work, because of how S3 requests are signed.

Every S3 request carries a **signature**. The client hashes parts of the request with a secret key, and the hostname is one of those parts. The server repeats the hash on what it received and accepts the request if the two match.

- If the hostname stays `b2-proxy.munchbox.cc`, Backblaze doesn't recognize it.
- If the hostname changes to Backblaze's on the way through, the hashes no longer match and Backblaze answers `SignatureDoesNotMatch`.

Something in the middle has to receive the request and sign a new one.

## Worker

A **Cloudflare Worker** is a small program that runs on Cloudflare's servers. When a request arrives for a hostname, Cloudflare runs the Worker and lets it decide what to do.

Here is one read, start to finish:

<svg class="flow" width="714" height="446" style="display:block;max-width:100%;height:auto;margin:28px 0 32px" viewBox="23 0 714 446" role="img" aria-labelledby="rq-t rq-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rq-t">One read through the Worker</title>
  <desc id="rq-d">Step 1: s3-orchestrator signs a request with the proxy key and sends it to b2-proxy.munchbox.cc. Step 2: the Cloudflare Worker checks the signature, and a wrong signature gets a 403 and stops there. Step 3: the Worker builds a new request and signs it with the real key. Step 4: Backblaze sends the object to the Worker, and that egress is waived. Step 5: the Worker passes the object back to s3-orchestrator.</desc>
  <style>
    .flow text { font-family: inherit; }
    .flow .lbl   { font-size: 16px; font-weight: 600; fill: var(--fg); }
    .flow .sub   { font-size: 14px; fill: var(--muted); }
    .flow .step  { font-size: 15px; fill: var(--fg); }
    .flow .micro { font-size: 12px; font-weight: 700; letter-spacing: .07em; fill: var(--accent); }
    .flow .mono  { font-size: 13.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; fill: var(--fg); }
    .flow .num   { font-size: 13px; font-weight: 700; fill: var(--bg); text-anchor: middle; }
    .flow .dot   { fill: var(--accent); }
    .flow .dot-b { fill: var(--nav); }
    .flow .box   { fill: var(--card); stroke: var(--border); stroke-width: 1.5; }
    .flow .ok    { fill: var(--card); stroke: var(--accent); stroke-width: 1.5; }
    .flow .stop  { fill: var(--bg); stroke: var(--accent-red); stroke-width: 1.5; }
    .flow .ln    { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .flow .ln-r  { fill: none; stroke: var(--accent-red); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .flow .ln-b  { fill: none; stroke: var(--nav); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  </style>
  <defs>
    <marker id="rqa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0l10 5-10 5z" fill="var(--accent)"/></marker>
    <marker id="rqr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0l10 5-10 5z" fill="var(--accent-red)"/></marker>
    <marker id="rqb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0l10 5-10 5z" fill="var(--nav)"/></marker>
  </defs>
  <rect x="24" y="14" width="712" height="72" rx="12" class="box"/>
  <text x="44" y="42" class="lbl">s3-orchestrator</text>
  <text x="44" y="66" class="mono">Host: b2-proxy.munchbox.cc</text>
  <path class="ln" marker-end="url(#rqa)" d="M130 86V164"/>
  <circle cx="130" cy="124" r="12" class="dot"/><text x="130" y="129" class="num">1</text>
  <text x="154" y="120" class="lbl">request</text>
  <text x="154" y="140" class="sub">signed with the proxy key</text>
  <path class="ln-b" marker-end="url(#rqb)" d="M470 166V88"/>
  <circle cx="470" cy="128" r="12" class="dot-b"/><text x="470" y="133" class="num">5</text>
  <text x="494" y="133" class="lbl">object</text>
  <rect x="24" y="166" width="712" height="116" rx="12" class="ok"/>
  <text x="44" y="194" class="lbl">Cloudflare Worker</text>
  <circle cx="56" cy="222" r="12" class="dot"/><text x="56" y="227" class="num">2</text>
  <text x="78" y="227" class="step">check the signature</text>
  <path class="ln-r" marker-end="url(#rqr)" d="M244 222H494"/>
  <circle cx="56" cy="254" r="12" class="dot"/><text x="56" y="259" class="num">3</text>
  <text x="78" y="259" class="step">build a new request, sign it with the real key</text>
  <rect x="496" y="180" width="222" height="84" rx="10" class="stop"/>
  <text x="512" y="214" class="lbl">wrong signature</text>
  <text x="512" y="236" class="sub">answer 403 and stop</text>
  <path class="ln" marker-end="url(#rqa)" d="M130 282V360"/>
  <text x="154" y="318" class="lbl">new request</text>
  <text x="154" y="338" class="sub">signed with the real key</text>
  <path class="ln-b" marker-end="url(#rqb)" d="M470 362V284"/>
  <circle cx="470" cy="322" r="12" class="dot-b"/><text x="470" y="327" class="num">4</text>
  <text x="494" y="318" class="lbl">object</text>
  <text x="494" y="338" class="sub">egress to Cloudflare, waived</text>
  <rect x="24" y="362" width="712" height="72" rx="12" class="box"/>
  <text x="44" y="390" class="lbl">Backblaze</text>
  <text x="44" y="414" class="mono">Host: s3.us-east-005.backblazeb2.com</text>
</svg>

1. The orchestrator signs a request with a **proxy key**, a key only the Worker accepts, and sends it to `b2-proxy.munchbox.cc`.
2. The Worker checks that signature. If it's wrong, the Worker answers `403` and stops.
3. The Worker builds a new request with Backblaze's hostname and signs it with the **real key**, which is Backblaze's own access key.
4. Backblaze accepts it and sends the object to the Worker. This is the step that saves the egress, because the data is going to Cloudflare.
5. The Worker streams the object back to the orchestrator.

The Worker's entry point is those steps in code:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      await verifyCaller(request, env);
      return await forward(request, env);
    } catch (err) {
      return errorResponse(err);
    }
  },
};
```

`verifyCaller` is step 2. `forward` is steps 3 to 5. If either one fails, `errorResponse` sends back an S3 error.

## Rebuilding the request

The Worker can't pass along the request it received, because that request is addressed to the Worker and signed with the proxy key. Backblaze would reject it. So the Worker makes a copy for Backblaze, changes what has to change, and signs the copy with the real key.

Here is the same read before and after, with long values shortened.

The request the Worker receives:

```text
GET /my-bucket/photos/cat.jpg
Host: b2-proxy.munchbox.cc
Authorization: AWS4-HMAC-SHA256
    Credential=PROXYKEYID/20261105/us-east-005/s3/aws4_request,
    SignedHeaders=host;x-amz-content-sha256;x-amz-date,
    Signature=736b9df3...
X-Amz-Date: 20261105T175949Z
X-Amz-Content-Sha256: e3b0c442...
Range: bytes=0-1023
CF-Connecting-IP: 203.0.113.7
CF-Ray: 8d2f0a1b2c3d4e5f-LAX
X-Forwarded-For: 203.0.113.7
Connection: keep-alive
```

The request the Worker sends to Backblaze:

```text
GET /my-bucket/photos/cat.jpg
Host: s3.us-east-005.backblazeb2.com
Authorization: AWS4-HMAC-SHA256
    Credential=PROVIDERKEYID/20261105/us-east-005/s3/aws4_request,
    SignedHeaders=host;x-amz-content-sha256;x-amz-date,
    Signature=d1e698cc...
X-Amz-Date: 20261105T175950Z
X-Amz-Content-Sha256: e3b0c442...
Range: bytes=0-1023
```

**Kept**, because these say what the caller wants:

- The method, path and query string.
- The body, which streams through without the Worker reading it.
- `X-Amz-Content-Sha256`, which describes the body. The body didn't change, so the value is still right.
- Other headers, like `Range`.

**Replaced**, because they were only true for the first request:

- `Host` becomes Backblaze's hostname, because Backblaze only answers to its own name.
- `X-Amz-Date` becomes the current time, because this is a new request and providers refuse old timestamps.
- `Authorization` gets a new key and signature, because the old one was made with the proxy key.

**Removed**, because they don't apply to the next hop:

- `CF-*`, `X-Forwarded-*` and `X-Real-IP`, which Cloudflare added for the Worker.
- `Connection`, `Transfer-Encoding` and similar headers, which describe the connection into the Worker.

To sign the copy, the Worker writes it out as text in the exact format S3 signing requires. This text is called the canonical request:

```text
GET
/my-bucket/photos/cat.jpg

host:s3.us-east-005.backblazeb2.com
x-amz-content-sha256:e3b0c442...
x-amz-date:20261105T175950Z

host;x-amz-content-sha256;x-amz-date
e3b0c442...
```

From top to bottom, that's the method, the path, the query string (empty here), the signed headers, the names of those headers, and the hash of the body. Headers like `Range` are sent but not signed.

The Worker hashes that text with a key derived from the Backblaze secret, and the result is the `Signature` in the new `Authorization` header. Backblaze writes out the same text from the request it received and repeats the hash. If a single character differs, the signatures don't match. That's why the hostname can't just be changed on the way through: it's one of the lines in this text.

## Keys

This is where each key comes from and where it ends up:

<svg class="flow" width="714" height="376" style="display:block;max-width:100%;height:auto;margin:28px 0 32px" viewBox="23 0 714 376" role="img" aria-labelledby="ky-t ky-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ky-t">Where each key comes from</title>
  <desc id="ky-d">The real key is created in the Backblaze console, stored in Vault at secret/s3-orchestrator, and uploaded by Terragrunt at deploy time as the Worker secret ORIGIN_SECRET_ACCESS_KEY. The proxy key is generated by Terragrunt and stored in Vault at secret/edge-proxy/b2. From there Terragrunt uploads one copy as the Worker secret PROXY_SECRET_ACCESS_KEY, and Nomad renders the other copy into the s3-orchestrator config.</desc>
  <defs>
    <marker id="kya" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0l10 5-10 5z" fill="var(--accent)"/></marker>
  </defs>
  <text x="24" y="20" class="micro">REAL KEY</text>
  <rect x="24" y="30" width="150" height="92" rx="12" class="box"/>
  <text x="38" y="56" class="lbl">Backblaze</text>
  <text x="38" y="78" class="sub">created in the</text>
  <text x="38" y="98" class="sub">console</text>
  <path class="ln" marker-end="url(#kya)" d="M174 76H199"/>
  <rect x="201" y="30" width="190" height="92" rx="12" class="box"/>
  <text x="215" y="56" class="lbl">Vault</text>
  <text x="215" y="78" class="mono">secret/</text>
  <text x="215" y="98" class="mono">s3-orchestrator</text>
  <path class="ln" marker-end="url(#kya)" d="M391 76H416"/>
  <rect x="418" y="30" width="120" height="92" rx="12" class="box"/>
  <text x="432" y="56" class="lbl">Terragrunt</text>
  <text x="432" y="78" class="sub">uploads at</text>
  <text x="432" y="98" class="sub">deploy</text>
  <path class="ln" marker-end="url(#kya)" d="M538 76H563"/>
  <rect x="565" y="30" width="171" height="92" rx="12" class="ok"/>
  <text x="579" y="56" class="lbl">Worker secret</text>
  <text x="579" y="78" class="mono">ORIGIN_SECRET_</text>
  <text x="579" y="98" class="mono">ACCESS_KEY</text>
  <text x="24" y="156" class="micro">PROXY KEY</text>
  <rect x="24" y="166" width="150" height="92" rx="12" class="box"/>
  <text x="38" y="192" class="lbl">Terragrunt</text>
  <text x="38" y="214" class="sub">generates a</text>
  <text x="38" y="234" class="sub">random keypair</text>
  <path class="ln" marker-end="url(#kya)" d="M174 212H199"/>
  <rect x="201" y="166" width="190" height="92" rx="12" class="box"/>
  <text x="215" y="192" class="lbl">Vault</text>
  <text x="215" y="214" class="mono">secret/edge-proxy/</text>
  <text x="215" y="234" class="mono">b2</text>
  <path class="ln" marker-end="url(#kya)" d="M391 212H416"/>
  <rect x="418" y="166" width="120" height="92" rx="12" class="box"/>
  <text x="432" y="192" class="lbl">Terragrunt</text>
  <text x="432" y="214" class="sub">uploads at</text>
  <text x="432" y="234" class="sub">deploy</text>
  <path class="ln" marker-end="url(#kya)" d="M538 212H563"/>
  <rect x="565" y="166" width="171" height="92" rx="12" class="ok"/>
  <text x="579" y="192" class="lbl">Worker secret</text>
  <text x="579" y="214" class="mono">PROXY_SECRET_</text>
  <text x="579" y="234" class="mono">ACCESS_KEY</text>
  <path class="ln" marker-end="url(#kya)" d="M296 258V296"/>
  <rect x="201" y="298" width="337" height="66" rx="12" class="ok"/>
  <text x="215" y="326" class="lbl">s3-orchestrator config</text>
  <text x="215" y="348" class="sub">Nomad renders it from Vault</text>
</svg>

**The real key** is Backblaze's own access key. I created it in the Backblaze console and stored it in Vault, my secrets store. When Terragrunt deploys the Worker, it reads the key from Vault and uploads it to Cloudflare as a Worker secret. Worker secrets appear as fields on `env`, so in step 3 the Worker reads `env.ORIGIN_SECRET_ACCESS_KEY`. The orchestrator's config doesn't contain this key.

**The proxy key** is a random keypair that Terragrunt generates and stores in Vault. Both ends need a copy, because a signature only verifies if both sides hold the same secret. Terragrunt uploads one copy to the Worker, and Nomad renders the other into the orchestrator's config.

Step 2 is what protects the real key. Without that check, the Worker would sign anything it received, and anyone who found the hostname could read and write the bucket.

The proxy key needs the same care as the real key, because whoever has it can ask the Worker to do anything the real key can do.

## Deployment

Cloudflare runs JavaScript and the Worker is TypeScript, so a release compiles it into one file and stores that file in a bucket. Consul records which version was released, and Vault holds the keys. Terragrunt, which manages my infrastructure, reads all three and deploys the same file once per provider with that provider's keys.

<svg class="flow" width="714" height="470" style="display:block;max-width:100%;height:auto;margin:28px 0 32px" viewBox="23 0 714 470" role="img" aria-labelledby="dp-t dp-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dp-t">How the Worker is deployed</title>
  <desc id="dp-d">A Forgejo release workflow bundles worker.js into the artifacts bucket, which s3-orchestrator serves, and records the version in Consul KV. Terragrunt reads the version, the bundle, and the keys from Vault, then deploys one Worker per backend from the same bundle: b2-proxy, ibm-proxy and oci-proxy on munchbox.cc.</desc>
  <defs>
    <marker id="dpa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0l10 5-10 5z" fill="var(--accent)"/></marker>
  </defs>
  <rect x="24" y="14" width="470" height="72" rx="12" class="box"/>
  <text x="44" y="42" class="lbl">Forgejo release workflow</text>
  <text x="44" y="66" class="sub">bundles worker.js and records the version</text>
  <path class="ln" marker-end="url(#dpa)" d="M138 86V122"/>
  <path class="ln" marker-end="url(#dpa)" d="M380 86V122"/>
  <rect x="24" y="124" width="228" height="112" rx="12" class="box"/>
  <text x="42" y="150" class="lbl">artifacts bucket</text>
  <text x="42" y="172" class="sub">served by s3-orchestrator</text>
  <text x="42" y="198" class="mono">cloudflare-worker/</text>
  <text x="42" y="218" class="mono">&lt;version&gt;/worker.js</text>
  <rect x="266" y="124" width="228" height="112" rx="12" class="box"/>
  <text x="284" y="150" class="lbl">Consul KV</text>
  <text x="284" y="172" class="sub">the released version</text>
  <text x="284" y="198" class="mono">deploy/versions/</text>
  <text x="284" y="218" class="mono">s3-orchestrator</text>
  <rect x="508" y="124" width="228" height="112" rx="12" class="box"/>
  <text x="526" y="150" class="lbl">Vault</text>
  <text x="526" y="172" class="sub">real keys</text>
  <text x="526" y="194" class="sub">proxy keys</text>
  <path class="ln" marker-end="url(#dpa)" d="M138 236V272"/>
  <path class="ln" marker-end="url(#dpa)" d="M380 236V272"/>
  <path class="ln" marker-end="url(#dpa)" d="M622 236V272"/>
  <rect x="24" y="274" width="712" height="72" rx="12" class="box"/>
  <text x="44" y="302" class="lbl">Terragrunt</text>
  <text x="44" y="326" class="sub">one Worker per provider, same file</text>
  <path class="ln" marker-end="url(#dpa)" d="M138 346V382"/>
  <path class="ln" marker-end="url(#dpa)" d="M380 346V382"/>
  <path class="ln" marker-end="url(#dpa)" d="M622 346V382"/>
  <rect x="24" y="384" width="228" height="72" rx="12" class="ok"/>
  <text x="42" y="412" class="lbl">b2 Worker</text>
  <text x="42" y="436" class="mono">b2-proxy.munchbox.cc</text>
  <rect x="266" y="384" width="228" height="72" rx="12" class="ok"/>
  <text x="284" y="412" class="lbl">ibm Worker</text>
  <text x="284" y="436" class="mono">ibm-proxy.munchbox.cc</text>
  <rect x="508" y="384" width="228" height="72" rx="12" class="ok"/>
  <text x="526" y="412" class="lbl">oci Worker</text>
  <text x="526" y="436" class="mono">oci-proxy.munchbox.cc</text>
</svg>

## DNS records

Each proxy hostname needs two DNS records.

**A public record in Cloudflare.** A Worker only runs for a hostname that goes through Cloudflare, so the name has to exist there with the proxy turned on. The Worker answers every request itself, so no real server sits behind the name. Mine point at `192.0.2.1`, an address reserved for documentation.

**A record on my home network.** My Pi-hole DNS server answers every `*.munchbox.cc` name with my own reverse proxy, so the orchestrator would never reach Cloudflare. Each proxy hostname gets its own Pi-hole entry pointing at a Cloudflare address.

## Backend configuration

Each backend points at its Worker and signs with the proxy key:

```yaml
backends:
  - name: "b2"
    endpoint: "https://b2-proxy.munchbox.cc"
    region: "us-east-005"
    bucket: "<bucket>"
    access_key_id: "<proxy key id>"
    secret_access_key: "<proxy secret>"
    force_path_style: true
    strip_sdk_headers: true
```

`strip_sdk_headers` is required. The Go SDK includes `accept-encoding` in its signature, and Cloudflare overwrites that header on the way in. The Worker then sees a different request from the one that was signed, so every request fails. The flag removes the header before signing.

## Limits

**Request body size.** On Cloudflare's Free and Pro plans, a request body over 100 MB gets a `413` error. Uploading in smaller parts doesn't help, because the orchestrator joins the parts and writes the finished object in one request. Setting `max_object_size` on the backend keeps large objects away from it, except multipart uploads, where the size isn't known until the end.

**Provider request limits.** The egress waiver only covers data transfer, and a provider can still limit how many requests you make. Backblaze's [pricing page](https://www.backblaze.com/cloud-storage/transaction-pricing) lists these reads as free, but my account got about 2,500 a day and the rest were refused:

<svg class="reads" width="760" height="400" style="display:block;max-width:100%;height:auto;margin:28px 0 32px" viewBox="0 0 760 400" role="img" aria-labelledby="rd-t rd-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rd-t">Backblaze B2 reads per day</title>
  <desc id="rd-d">Stacked columns of GetObject and HeadObject calls per UTC day, with a reference line at 2,500. Oct 22: 1,140 served, 0 refused; Oct 23: 800 served, 0 refused; Oct 24: 976 served, 6 refused; Oct 25: 2,586 served, 202 refused; Oct 26: 2,659 served, 888 refused; Oct 27: 2,590 served, 654 refused; Oct 28: 2,646 served, 883 refused; Oct 29: 2,791 served, 628 refused; Oct 30: 2,514 served, 464 refused; Oct 31: 2,523 served, 556 refused; Nov 1: 730 served, 0 refused; Nov 2: 17 served, 0 refused; Nov 3: 175 served, 0 refused; Nov 4: 142 served, 0 refused.</desc>
  <style>
    .reads { --served: #2563eb; --refused: #ef4444; }
    @media (prefers-color-scheme: dark) { :root:not([data-theme]) .reads { --served: #4f8fea; --refused: #ea5353; } }
    :root[data-theme='dark'] .reads { --served: #4f8fea; --refused: #ea5353; }
    .reads text { font-family: inherit; }
    .reads .ttl { font-size: 16px; font-weight: 600; fill: var(--fg); }
    .reads .tick { font-size: 13px; fill: var(--muted); }
    .reads .key { font-size: 14px; fill: var(--fg); }
    .reads .grid { stroke: var(--border); stroke-width: 1; }
    .reads .limit { stroke: var(--fg); stroke-width: 1.5; }
    .reads .srv { fill: var(--served); }
    .reads .rfd { fill: var(--refused); }
    .reads .hit { fill: transparent; }
  </style>
  <text x="0" y="20" class="ttl">Backblaze B2 reads per day</text>
  <rect x="0" y="36" width="12" height="12" rx="3" class="srv"/><text x="18" y="47" class="key">Served</text>
  <rect x="84" y="36" width="12" height="12" rx="3" class="rfd"/><text x="102" y="47" class="key">Refused by Backblaze</text>
  <line class="grid" x1="60" x2="748" y1="356.0" y2="356.0"/><text x="50" y="360.0" text-anchor="end" class="tick">0</text>
  <line class="grid" x1="60" x2="748" y1="285.5" y2="285.5"/><text x="50" y="289.5" text-anchor="end" class="tick">1,000</text>
  <line class="grid" x1="60" x2="748" y1="215.0" y2="215.0"/><text x="50" y="219.0" text-anchor="end" class="tick">2,000</text>
  <line class="grid" x1="60" x2="748" y1="144.5" y2="144.5"/><text x="50" y="148.5" text-anchor="end" class="tick">3,000</text>
  <line class="grid" x1="60" x2="748" y1="74.0" y2="74.0"/><text x="50" y="78.0" text-anchor="end" class="tick">4,000</text>
  <g><title>Oct 22: 1,140 served, 0 refused</title><rect class="hit" x="60.0" y="74" width="49.1" height="282"/><path class="srv" d="M72.6 356.0V279.6Q72.6 275.6 76.6 275.6H92.6Q96.6 275.6 96.6 279.6V356.0Z"/></g>
  <text x="84.6" y="378" text-anchor="middle" class="tick">Oct 22</text>
  <g><title>Oct 23: 800 served, 0 refused</title><rect class="hit" x="109.1" y="74" width="49.1" height="282"/><path class="srv" d="M121.7 356.0V303.6Q121.7 299.6 125.7 299.6H141.7Q145.7 299.6 145.7 303.6V356.0Z"/></g>
  <g><title>Oct 24: 976 served, 6 refused</title><rect class="hit" x="158.3" y="74" width="49.1" height="282"/><path class="srv" d="M170.9 356.0V291.2Q170.9 287.2 174.9 287.2H190.9Q194.9 287.2 194.9 291.2V356.0Z"/></g>
  <text x="182.9" y="378" text-anchor="middle" class="tick">Oct 24</text>
  <g><title>Oct 25: 2,586 served, 202 refused</title><rect class="hit" x="207.4" y="74" width="49.1" height="282"/><rect class="srv" x="220.0" y="173.7" width="24" height="182.3"/><path class="rfd" d="M220.0 171.7V161.4Q220.0 157.4 224.0 157.4H240.0Q244.0 157.4 244.0 161.4V171.7Z"/></g>
  <g><title>Oct 26: 2,659 served, 888 refused</title><rect class="hit" x="256.6" y="74" width="49.1" height="282"/><rect class="srv" x="269.1" y="168.5" width="24" height="187.5"/><path class="rfd" d="M269.1 166.5V107.9Q269.1 103.9 273.1 103.9H289.1Q293.1 103.9 293.1 107.9V166.5Z"/></g>
  <text x="281.1" y="378" text-anchor="middle" class="tick">Oct 26</text>
  <g><title>Oct 27: 2,590 served, 654 refused</title><rect class="hit" x="305.7" y="74" width="49.1" height="282"/><rect class="srv" x="318.3" y="173.4" width="24" height="182.6"/><path class="rfd" d="M318.3 171.4V129.3Q318.3 125.3 322.3 125.3H338.3Q342.3 125.3 342.3 129.3V171.4Z"/></g>
  <g><title>Oct 28: 2,646 served, 883 refused</title><rect class="hit" x="354.9" y="74" width="49.1" height="282"/><rect class="srv" x="367.4" y="169.5" width="24" height="186.5"/><path class="rfd" d="M367.4 167.5V109.2Q367.4 105.2 371.4 105.2H387.4Q391.4 105.2 391.4 109.2V167.5Z"/></g>
  <text x="379.4" y="378" text-anchor="middle" class="tick">Oct 28</text>
  <g><title>Oct 29: 2,791 served, 628 refused</title><rect class="hit" x="404.0" y="74" width="49.1" height="282"/><rect class="srv" x="416.6" y="159.2" width="24" height="196.8"/><path class="rfd" d="M416.6 157.2V117.0Q416.6 113.0 420.6 113.0H436.6Q440.6 113.0 440.6 117.0V157.2Z"/></g>
  <g><title>Oct 30: 2,514 served, 464 refused</title><rect class="hit" x="453.1" y="74" width="49.1" height="282"/><rect class="srv" x="465.7" y="178.8" width="24" height="177.2"/><path class="rfd" d="M465.7 176.8V148.1Q465.7 144.1 469.7 144.1H485.7Q489.7 144.1 489.7 148.1V176.8Z"/></g>
  <text x="477.7" y="378" text-anchor="middle" class="tick">Oct 30</text>
  <g><title>Oct 31: 2,523 served, 556 refused</title><rect class="hit" x="502.3" y="74" width="49.1" height="282"/><rect class="srv" x="514.9" y="178.1" width="24" height="177.9"/><path class="rfd" d="M514.9 176.1V140.9Q514.9 136.9 518.9 136.9H534.9Q538.9 136.9 538.9 140.9V176.1Z"/></g>
  <g><title>Nov 1: 730 served, 0 refused</title><rect class="hit" x="551.4" y="74" width="49.1" height="282"/><path class="srv" d="M564.0 356.0V308.5Q564.0 304.5 568.0 304.5H584.0Q588.0 304.5 588.0 308.5V356.0Z"/></g>
  <text x="576.0" y="378" text-anchor="middle" class="tick">Nov 1</text>
  <g><title>Nov 2: 17 served, 0 refused</title><rect class="hit" x="600.6" y="74" width="49.1" height="282"/><rect class="srv" x="613.1" y="354.8" width="24" height="1.2"/></g>
  <g><title>Nov 3: 175 served, 0 refused</title><rect class="hit" x="649.7" y="74" width="49.1" height="282"/><path class="srv" d="M662.3 356.0V347.7Q662.3 343.7 666.3 343.7H682.3Q686.3 343.7 686.3 347.7V356.0Z"/></g>
  <text x="674.3" y="378" text-anchor="middle" class="tick">Nov 3</text>
  <g><title>Nov 4: 142 served, 0 refused</title><rect class="hit" x="698.9" y="74" width="49.1" height="282"/><path class="srv" d="M711.4 356.0V350.0Q711.4 346.0 715.4 346.0H731.4Q735.4 346.0 735.4 350.0V356.0Z"/></g>
  <line class="limit" x1="60" x2="748" y1="179.8" y2="179.8"/>
  <text x="748" y="171.8" text-anchor="end" class="key">2,500 a day</text>
</svg>

Each refused read got this error:

```text
403 AccessDenied: Cannot download file, download bandwidth or transaction
(Class B) cap exceeded. See the Caps & Alerts page to increase your cap.
```

On October 31, 59 reads from real clients hit it. Nine were served from another copy, and 50 failed with a `502`. Synology C2 was also over its own download limit that day.

## Results

On one day, 1,679 MB came out of B2 and Backblaze counted 42 MB of it as egress.

In the week ending November 5, the three Workers handled about 36,000 uploads and 11,000 downloads. Ten uploads failed, four of them large Postgres backups rejected with a `413`.

## Source

The Worker is in [deploy/cloudflare-worker](https://github.com/afreidah/s3-orchestrator/tree/main/deploy/cloudflare-worker), and the [guide](https://s3-orchestrator.munchbox.cc/guides/cloudflare-edge-proxy/) covers setting one up. The Terragrunt is in [munchbox](https://github.com/afreidah/munchbox).
