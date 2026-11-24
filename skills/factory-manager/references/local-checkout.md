## Step 0: the code on this computer

Read once when establishing a repository checkout, or when its validation fails.

Before any research or station (once a session, and again when a check fails), the code must be on this computer and
git connected. This setup is not factory work: no story. Cloning and adding a remote need the person's yes; using the
folder this session is already in does not. For each of `manager_brief.you.local_code.repositories`, one line each
("payments: ~/code/payments, connected."):
1. **No `checkout_path`**: if this session's folder is a checkout of it (its `origin` is the same owner/name as
   `clone_url` or `html_url`, ssh or https, with or without `.git`), use it and say so ("payments: using this
   folder."). Else ask for the folder of an existing checkout, or a folder to clone it into (for example `~/code`).
   Save it with
   `set_local_checkout { factory, repository, path, mode }` (`existing` or `clone_into`); use the `checkout_path` it
   answers. Quote every path and address in a command (`"<checkout_path>"`, `"<clone_url>"`); `~` is the home folder
   and is not expanded inside quotes, so write a `~/…` path as `"$HOME/…"`.
2. **Check it**: the folder exists; `git -C "<checkout_path>" rev-parse --show-toplevel` works; `git -C
   "<checkout_path>" remote get-url origin` names that repository; `git -C "<checkout_path>" ls-remote origin HEAD`
   works (git is connected); then `git -C "<checkout_path>" fetch origin`.
3. **Missing** (or empty) → "Clone <clone_url> into <checkout_path>?"; on yes `git clone "<clone_url>" "<checkout_path>"`,
   and check again. **Not a git repository, or another `origin`** → say what is there and ask: another folder, or
   add the remote (`git -C "<checkout_path>" remote add origin "<clone_url>"`, only when it has no `origin`). **`ls-remote` refused** →
   say what git said; the person signs in to git or `gh` themselves. Never delete, move or overwrite a folder or
   remote.

No `you.local_code` (an older CodeBook): this session's folder is the checkout, checked the same way. From here on
**`checkout_path` is where the code is**, not wherever this session was opened: research, workers and worktrees use it
(`git -C "<checkout_path>"`, `cd "<checkout_path>"`), and worktrees go next to it, `"<checkout_path>-<n>"` (the story's
number).
