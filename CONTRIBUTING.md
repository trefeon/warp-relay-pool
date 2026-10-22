# Contributing to warp-relay-pool

Thanks for contributing. This repo is evidence-first: terse, exact
file/symbol/command names, no marketing filler, no invented
versions or benchmarks.

## PR flow

1. Fork, branch from `main`, keep the diff focused.
2. Describe what changed and how you verified it.
3. Wait for review; keep the branch updated until merged.

## Generated-file rule

- `docker-compose.yml` is generated — never edit it by hand.
- Change `generate-compose.sh` (or its inputs) and regenerate:
  `sh generate-compose.sh`
- Commit both the generator change and the regenerated output.

## Privacy rule

- Never commit tunnel URLs (`<RELAY-N-URL>`) or egress IPs (`<EGRESS-IP>`).
- `get-status.sh` output stays host-only; scrub it before pasting.
- Use the `<RELAY-N-URL>` / `<EGRESS-IP>` placeholders in docs and issues.
- Canonical rules, security model, and vulnerability reporting:
  [SECURITY.md](SECURITY.md).

## Smoke check

Run before opening a PR:

```sh
node --check server.mjs
node --check keep-cold.mjs
for f in generate-compose.sh setup.sh get-status.sh logwatch.sh \
         logwatch.test.sh warp-lite/entrypoint.sh; do
  sh -n "$f"          # `sh -n a b c` would parse only the first file
done
npm ci --no-audit --no-fund
bash logwatch.test.sh
node --test test/*.test.mjs
sh ./generate-compose.sh 10
git diff --exit-code docker-compose.yml
docker compose config -q
```

CI (`.github/workflows/ci.yml`) runs the same gates plus ShellCheck, a
`warp-lite` image build, and a gitleaks scan. Commit `package-lock.json`
whenever `package.json` changes — CI uses `npm ci`.

## Style

- Runtime protocol and topology are frozen (see `README.md`); proposals
  that change them belong in an issue first.
- Scripts must stay `sh`-portable; the repo runs on a Docker Linux host.
- No secrets in the tree: `.env*` (except `.env.example`) is ignored.
