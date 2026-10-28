# Per-worktree dev environment (podman)

Dev environments on this computer are **podman**, never docker: `podman compose -f compose.dev.yml …`.
The podman machine is frequently stopped; `podman ps` answering "Cannot connect to Podman …
connection refused" means start it, not that podman is missing.

Each worktree gets its **own compose project** so two stacks can run side by side: the project
name isolates containers and volumes (`charon-<slug>-postgres-1`, `charon-<slug>_charon-dev-db`),
and two environment variables move the published ports off the main stack's `5432` / `3000`
(`compose.dev.yml` reads `CHARON_DEV_PG_PORT` / `CHARON_DEV_APP_PORT`, defaulting to those).

The repo has three compose files; only `compose.dev.yml` is the per-worktree dev stack:

| File | What it is |
|---|---|
| `compose.dev.yml` | bind-mounted `src/`, `public/`, `prisma/`; `Dockerfile.dev` runs `prisma migrate deploy` then `tsx --watch src/index.ts` as the single `all` role. Env (throwaway dev `DATABASE_URL`, `SESSION_SECRET`, `CHARON_DATA_KEY`) is set inline in the file. |
| `compose.podman.yml` | the production image as one all-in-one process + Postgres over plain HTTP; one-shot migrate → seed (admin / admin, dev only) → charon. |
| `compose.setup.yml` | the production image with no `DATABASE_URL`, to exercise the first-run wizard. |

## Bring it up

From the worktree root (the stack bind-mounts the worktree, so hot reload edits this branch):

    podman machine start                                  # idempotent
    printf '%s %s\n' "$(date -u +%FT%TZ)" "dev stack charon-<slug> pg=<pgport> app=<appport>" > DEVLOCK

    # pick the lowest free pair starting at 5433 / 3100 (podman ps -a shows what is taken)
    export CHARON_DEV_PG_PORT=<pgport> CHARON_DEV_APP_PORT=<appport>
    podman compose -f compose.dev.yml -p charon-<slug> up -d --build

The app container migrates on start. Seed the built-in roles and a first admin (the seed only
creates the admin when both variables are set — use throwaway values):

    podman compose -f compose.dev.yml -p charon-<slug> exec \
      -e CHARON_SEED_ADMIN_USER=admin -e CHARON_SEED_ADMIN_PASSWORD=<dev-only> app \
      node --import tsx/esm prisma/seed.ts

Then open `http://127.0.0.1:<appport>`.

Note the host-side `DATABASE_URL` differs from the in-network one: from the host (running
`npm run dev` natively or the vitest suite) it is
`postgresql://charon:charon@127.0.0.1:<pgport>/charon`.

**Published ports bind `127.0.0.1` inside the podman VM.** On the WSL backend that can leave a
port answering inside the VM but unreachable from Windows — a `P1001: Can't reach database
server` against a container `podman ps` shows healthy reads as a broken container rather than a
binding. If the host cannot reach the port, dial the podman machine's IP
(`podman machine ssh "ip -4 addr show eth0"`) or publish on all interfaces for that run. The
machine IP moves when WSL restarts, so read it each time.

## Run the tests against it

    DATABASE_URL="postgresql://charon:charon@127.0.0.1:<pgport>/charon" npx vitest run --no-file-parallelism

**Use a separate database for tests that write**, not the stack's dev database: an integration
test run against a stack that holds hand-made data deletes it. Create `charon_test` in the same
Postgres (`podman exec charon-<slug>-postgres-1 psql -U charon -c "CREATE DATABASE charon_test OWNER charon;"`),
`npx prisma migrate deploy` against it, and point the run there.

**A green run may be a run that did nothing.** Tests gated on `DATABASE_URL` skip themselves
when it is unset or unreachable — vitest exits 0 and the skipped count is the only tell. Read
the **skipped** count, not the exit code. And having watched a new test pass, make it FAIL once
(comment out the guard it covers) before trusting it.

## Tear it down

    podman compose -f compose.dev.yml -p charon-<slug> down -v      # containers + volumes
    rm DEVLOCK

`down -v` removes the named volumes of THIS project only. The main stack (project `charon`) is
untouched. Delete `DEVLOCK` only after the stack is gone; the merge protocol refuses a worktree
whose `DEVLOCK` is still present.

## Gotchas

- Omit `-p` and you are operating the MAIN dev stack (the project name defaults from the
  directory or the file).
- **Anything you park in `.env` reaches every test.** `tests/setup.ts` dotenv-loads it so the
  suite picks up `DATABASE_URL` the way `npm run dev` does, so a var added there for a local
  experiment silently changes test behaviour. Pass such vars on the command line instead.
- **Stopping `npm run dev` may not free the port.** Killing the npm wrapper can leave the node
  child listening, so the server you "restarted" never binds and you keep testing the old
  process with the old env. Check `netstat -ano | grep ':<port> .*LISTENING'` and kill that PID.
- `podman machine ssh` on Windows can drop a literal file named `NUL` into the cwd; delete it
  before `git add -A`.
- Dev keys and passwords in the compose files are throwaway values. Never put a real secret in
  a compose file, `.env.example`, a seed or a test — the repo is public.
