# External bucket recovery lab

**Status: prepared, not run.** The current workspace denies the Linux route
netlink socket that MinIO needs during startup. The official MinIO binary exits
before either `--version` or explicit loopback listener configuration can run.
This is an execution-environment blocker; it is not a failed celld recovery test.

Evidence is in `blocker.json`, `socket-capabilities.json`, and
`minio-startup.stderr.log`. The executable was downloaded from the official
release and its SHA-256 was checked:

- celld: `0.6.1`.
- MinIO: `RELEASE.2025-04-22T22-12-26Z`.
- SHA-256: `53e2a2cb16c5366ea6fbbc479c19ddb4c6a0948273e752f740fb1fbf27bb817c`.
- Failure: `socket(AF_NETLINK, SOCK_RAW, NETLINK_ROUTE)` returns `EPERM`.
- MinIO unconditionally calls `net.Interfaces()` while initializing
  `cmd/net.go`, then its fatal-logging path panics.

No S3 compatibility, multi-node ownership transfer, fresh-directory restore, or
Cloudflare R2 result is claimed by this lab. Do not work around the workspace
restriction; run this lab on an ordinary Linux host with the required capability.

## What this lab can establish

The following commands use the production celld S3 path with a **local MinIO
server**, two celld processes, and distinct local working directories. They do
not use `celld dev` and do not test Cloudflare R2. The MinIO process and its data
directory deliberately survive celld process failures.

The small `smoke` Worker exercises transactional SQL, stable operation IDs, and
alarms. `storage_contract.py` checks conditional create, stale-write rejection,
concurrent compare-and-swap, consistent reads/listing, and exact ranged bytes.
It does not simulate an S3 server. Passing this small probe would not qualify a
store for production or establish all of celld's guarantees.

## Prerequisites

Use an otherwise idle Linux host, Python 3, Node 24, Bun 1.4.2, and the celld binary. Bind
all services to loopback. The credentials below belong only to this isolated lab.
Keep this directory after the run so evidence and object-store data survive.

```bash
cd /absolute/path/to/celld-bucket-lab
export LAB="$PWD"
export CELLD_BIN=/absolute/path/to/celld

python3 -m venv "$LAB/venv"
"$LAB/venv/bin/pip" install boto3==1.40.50
mkdir -p "$LAB/tooling"
bun add --cwd "$LAB/tooling" --exact esbuild@0.28.2
export CELLD_ESBUILD="$LAB/tooling/node_modules/.bin/esbuild"

mkdir -p "$LAB/bin"
curl -fL 'https://github.com/minio/minio/releases/download/RELEASE.2025-04-22T22-12-26Z/minio.linux-amd64.RELEASE.2025-04-22T22-12-26Z' -o "$LAB/bin/minio"
sha256sum "$LAB/bin/minio"
```

Verify the hash above before running the binary. The September 2025 MinIO release
is deliberately not used: celld documents a conditional-create incompatibility.

## Start and check the object store

```bash
chmod +x "$LAB/bin/minio"
export MINIO_ROOT_USER=perch-local-lab
export MINIO_ROOT_PASSWORD=perch-local-lab-password
export CELLD_LAB_ACCESS_KEY="$MINIO_ROOT_USER"
export CELLD_LAB_SECRET_KEY="$MINIO_ROOT_PASSWORD"

"$LAB/bin/minio" server \
  --address 127.0.0.1:19860 \
  --console-address 127.0.0.1:19861 \
  "$LAB/minio-data" > "$LAB/minio.log" 2>&1 &
minio_pid=$!

curl --fail --retry 20 --retry-delay 1 --retry-connrefused \
  http://127.0.0.1:19860/minio/health/live

"$LAB/venv/bin/python" "$LAB/storage_contract.py" --create-bucket \
  > "$LAB/storage-contract-result.json"
cat "$LAB/storage-contract-result.json"
```

Stop if the probe fails. It creates and removes one unique test object and keeps
the bucket. It accepts only loopback endpoints and does not load cloud credentials.

## Deploy and start two separate nodes

```bash
export AWS_ACCESS_KEY_ID="$CELLD_LAB_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$CELLD_LAB_SECRET_KEY"
export AWS_REGION=us-east-1
export S3_ENDPOINT=http://127.0.0.1:19860
export CELLD_BUCKET=s3://perch-celld-lab/counter-proof
export CELLD_DURABILITY=bucket

"$CELLD_BIN" deploy "$LAB/smoke" --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"

CELLD_WATCH="$LAB/node-a" "$CELLD_BIN" \
  --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION" \
  --listen 127.0.0.1:19870 --internal-listen 127.0.0.1:19871 \
  --advertise 127.0.0.1:19871 > "$LAB/node-a.log" 2>&1 &
node_a_pid=$!

CELLD_WATCH="$LAB/node-b" "$CELLD_BIN" \
  --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION" \
  --listen 127.0.0.1:19872 --internal-listen 127.0.0.1:19873 \
  --advertise 127.0.0.1:19873 > "$LAB/node-b.log" 2>&1 &
node_b_pid=$!

"$CELLD_BIN" diagnose --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" --region "$AWS_REGION" --json \
  > "$LAB/diagnose.jsonl"
```

The explicit `bucket` mode makes the bucket the acknowledged-write durability
boundary even when peers exist. Do not reuse a `CELLD_NODE` ID between process
lifetimes; these commands use generated session IDs. Each process has its own
`CELLD_WATCH` directory.

## Acknowledge a write and preserve artifact bytes

```bash
curl --fail --retry 20 --retry-delay 1 --retry-connrefused \
  -X POST 'http://127.0.0.1:19870/add?key=bucket-proof-v1' > "$LAB/before.json"

"$CELLD_BIN" r2 put lab-artifacts artifact.md --path "$LAB/artifact.md" \
  --content-type text/markdown --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"

curl --fail -X POST \
  'http://127.0.0.1:19870/schedule?after=90000' > "$LAB/scheduled.json"

curl --fail http://127.0.0.1:19871/state > "$LAB/node-a-state.json"
curl --fail http://127.0.0.1:19873/state > "$LAB/node-b-state.json"
```

The Worker stores its operation ID in the same transaction as its counter. The
R2 binding's artifact is stored separately under celld's object-store prefix.
The CLI round-trip below verifies object bytes; it does not test a mobile preview.

## Exercise owner loss, then fresh local directories

Inspect the two state records first. Node A must own the target cell for the first
kill to establish owner loss. A public listener can forward requests to a peer;
receiving the request alone does not establish ownership. If node B owns the cell,
swap A and B in the first takeover step and record that choice.

```bash
kill -KILL "$node_a_pid"

curl --fail --max-time 120 \
  http://127.0.0.1:19872/ > "$LAB/after-owner-loss.json"

kill -KILL "$node_b_pid"

test ! -e "$LAB/node-c-fresh"
CELLD_WATCH="$LAB/node-c-fresh" "$CELLD_BIN" \
  --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION" \
  --listen 127.0.0.1:19874 --internal-listen 127.0.0.1:19875 \
  --advertise 127.0.0.1:19875 > "$LAB/node-c.log" 2>&1 &
node_c_pid=$!

curl --fail --max-time 120 --retry 20 --retry-delay 1 --retry-connrefused \
  http://127.0.0.1:19874/ > "$LAB/after-fresh-directory.json"

curl --fail -X POST \
  'http://127.0.0.1:19874/add?key=bucket-proof-v1' > "$LAB/after-retry.json"

"$CELLD_BIN" r2 get lab-artifacts artifact.md --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" --region "$AWS_REGION" \
  > "$LAB/artifact-restored.md"
cmp "$LAB/artifact.md" "$LAB/artifact-restored.md"
sha256sum "$LAB/artifact.md" "$LAB/artifact-restored.md"
```

The original working directories remain as evidence, but node C is configured
with a new empty directory. Verify that no earlier celld process remains alive.
Recovery can take longer than the default ten-second owner lease. Do not interpret
a transient failure as state loss; retain logs and repeat the read after recovery.

For an **alarm-only** test, run the schedule in a separate fresh fleet prefix,
kill all celld processes, and start node C without sending any Worker request.
Wait until the scheduled time plus the waker scan interval, then make the first
read. That distinction prevents a read-triggered activation from being mistaken
for an alarm-triggered wake. The generic commands above test restoration of an
alarm but do not alone establish wake without incoming traffic.

## Check the actual results

```bash
"$LAB/venv/bin/python" - <<'PY'
import json, os
from pathlib import Path
p = Path(os.environ['LAB'])
def read(name):
    return json.loads((p / name).read_text())
before = read('before.json')
for name in ['after-owner-loss.json', 'after-fresh-directory.json', 'after-retry.json']:
    after = read(name)
    assert after['name'] == before['name']
    assert after['operations'] == before['operations']
    counts = {row['name']: row['value'] for row in after['counts']}
    assert counts['writes'] == 1, (name, counts)
    print(name, 'persisted operation and counter match')
assert read('after-fresh-directory.json')['instance'] != before['instance']
assert (p / 'artifact.md').read_bytes() == (p / 'artifact-restored.md').read_bytes()
print('Fresh instance restored the exact committed state and artifact bytes')
PY
```

These expectations assume a fresh `counter-proof` prefix and the one operation
shown. For repeated experiments, choose a new prefix and a new empty node C
directory. Preserve the generated reports and full node logs.

## Pi integration still required

The existing Pi experiment driver, `test/recovery.mjs`, starts and stops `celld dev`
itself. It has no external-base-URL option and cannot drive these bucket-backed
fleet nodes unchanged. The steps in this document currently exercise only the
small `smoke` Worker.

To extend the experiment, separate the Pi driver's request and assertion logic
from its process lifecycle, then add support for externally managed node URLs and
the node failure sequence above. Deploy the Pi experiment's Wrangler project in
place of `smoke`, using a fresh `CELLD_BUCKET` prefix and new local directories.
The adapted driver must check Pi submission IDs, transcript, effect receipts, and
artifact bytes. The counter assertions above do not establish Pi recovery.

To test real R2 later, create a dedicated bucket/prefix and substitute its endpoint,
region `auto`, and scoped S3 credentials. The loopback-only storage probe deliberately
does not accept that endpoint. Run celld's own `diagnose` against R2 and, after the
driver integration described above, run the Pi fault scenarios. R2 latency,
permission configuration, and recovery remain unverified until that run occurs.

## Sources

- [celld configuration, MinIO qualification limits, deployment, and flags](https://celld.dev/docs/)
- [celld storage and ownership guarantees](https://celld.dev/docs/guarantees/)
- [celld live-fleet fault tests](https://celld.dev/docs/testing/)
- [MinIO release](https://github.com/minio/minio/releases/tag/RELEASE.2025-04-22T22-12-26Z)
- [MinIO unconditional interface initialization](https://github.com/minio/minio/blob/RELEASE.2025-04-22T22-12-26Z/cmd/net.go#L35-L76)

This local MinIO build is a reproducibility dependency for an isolated experiment,
not a recommendation to expose an old object-store service publicly.
