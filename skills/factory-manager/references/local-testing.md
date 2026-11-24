# Local app checks, when the criterion needs them

Test on a local copy of the app that you build yourself. Never test against production. Build and start the app from
your checkout, on free ports, with a throwaway database. Seed it, and create your own test accounts and organisations
there. Use stand-ins for sign-in and for outside services. Ask a person only for a real outside account that no
stand-in can replace, and offer to skip that one check. When you are done, stop the app and throw the local database
away.

Here "your checkout" is your own worktree (`<checkout_path>-<n>`): never the person's checkout, their running app,
their ports or their database. You do not need the person for any of this, and "there is no test environment" or "I
have no account" is never a reason to stop: you make both. In steps:

1. **Find how the app starts.** Read the repository: package scripts, README, CLAUDE.md, AGENTS.md, Dockerfile,
   compose files, `.env.example`, the CI workflow, and any smoke or end-to-end harness under `scripts/` or `test/`.
   A harness that already starts a seeded instance is the first choice. The recipe's `start`, `seed` and `health_url`
   steps are hints too.
2. **Build from your worktree** (`<checkout_path>-<n>`), at the commit under test, and install there. Never build or
   start anything from the person's checkout.
3. **Free ports.** Ask the system for one (bind port 0), or try the next when one is taken. Never the port a README
   or an `.env` names: the person's own instance may be on it. Never stop a process you did not start.
4. **A throwaway database.** A new SQLite file under your worktree or a temporary folder, or a new database on a
   local server with your run number in its name (`app_test_run_812`). Never a database the person's app uses, and
   never a connection that names another host. Run the migrations on it.
5. **Seed it, and create the accounts there.** Use the repository's seed script or fixtures. Else sign up through the
   app's own sign-up or API, or insert the rows the way its tests do. Make the organisations, users and roles the
   story needs. Make up their passwords, keep them in your instance's own files, and never write them on the card.
6. **Stand-ins for what is outside.** Sign-in through an identity provider (SSO, OAuth, SAML): a local stand-in
   provider, or the app's own test sign-in when it has one. Email, payments, webhooks, model providers, git hosts and
   other services: a local stub that answers as the real one does, a recorded response, or a contract test of the
   request the app sends. Point your instance at them with its own environment, never by editing the person's files.
7. **Settings.** Copy `.env.example` (or the like) into your worktree and fill it with made-up local values. Never
   copy the person's `.env` and never read a secret out of it: a service that needs a real key gets a stand-in.
8. **Test against it**: only the changed behavior and relevant acceptance criteria. Use a real browser when browser interactions are required; HTTP is useful supporting evidence but cannot stand in for a browser criterion. If the capability is unavailable, report that gap separately from a failed check. Then stop
   the app and throw the local database away. Stop only what you started.
9. **Write what you ran** in the test report: the commit, how the instance was started, what was a stand-in, and
   what was not checked.

**Finish with a stand-in.** If the story can be finished with a stand-in, a recorded response or a contract test,
finish it that way. Write on the card what was not checked. A story waits for a person only when nothing else can
finish it. Then say in one sentence what only the person can give.

- What was not checked goes in the test report and in your summary, in one line starting "Not checked:" ("Not
  checked: a real Stripe charge. A local stub answered as Stripe's test mode does."). A pass with a note is appropriate only when the agreed criteria and required proof are satisfied. A stand-in does not waive a real-service requirement, browser requirement or human sign-off.
- **A real outside account that no stand-in can replace** (the criterion itself is about the real service: an app
  store's review, a real carrier's text message): first finish and record everything the stand-in covers. Then ask
  once, with `request_person`, and offer to skip that one check: "Checking the push certificate needs a real Apple
  developer account. Sign in to one here, or I skip that one check and write it on the card." Never ask for a
  password, a key or a token in the chat or on the card: the person signs in themselves.

