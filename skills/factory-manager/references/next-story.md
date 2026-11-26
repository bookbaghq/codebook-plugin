## 4b. Take the next story

Read when choosing the next ready story after a completed or stopped story, a passed milestone, or a newly blocked
branch, within current authorization. A plugin continuation notice is an observation, not approval: inspect the actual
state below. Keep independent authorized work moving while a true blocker waits; do not repeat unchanged failed proof
requests or tests. The owning session observes its unfinished orders after their current stories finish, so a later
milestone can wake it. Duplicate observations stay quiet; `/factory stop` stops that session's observation.

What happens when a story finishes is the factory's setting too (`manager_brief.goes_alone.next`, section 3):

- **Where it lets you go alone** (`approved_order`, `full`): When a story finishes, start the next ready story
  yourself, up to the factory's limits, and keep going until nothing is ready. Do not wait to be asked, and do not end
  the turn while a ready story has a free slot. CodeBook also starts the next ready story of a work order itself when
  one of its stories finishes: such a story then waits in `list_my_work`, so look there first and never start one
  twice.
- **Where it says to ask** (`suggest`, and an older CodeBook with no `goes_alone`): When a story finishes, say which
  story is ready next and ask "proceed?". One short list and one question for everything that is ready, not a
  question per story.

Either way, look for the next ready story yourself after each story reaches Done (or is stopped), in this order:

1. `list_my_work { factory }`: a run of a story you manage that waits for this runner. It is not a new story: start
   its worker (section 4) without asking.
2. **Open proposals** (`manager_brief.proposals`, `work_orders { factory, order }`): a line that waited for the story
   that just finished is ready now (`confirm_stories { proposal, stories }`, with `decided_by: "manager"` where you
   go alone).
3. **The proposed stories drawer.** After each finished story, look at the Backlog too. Start the stories that are ready, as the
   factory's setting for new stories allows, and tell the person which ones are parked and on what. It is in
   `manager_brief.backlog` (call `manager_brief` again after each finished story: the brief is read fresh each time):
   `{ stories: [{ story, title, workflow, proposal?, ready, parked_on, start_with? }], ready, parked, say }`. A story
   with `ready: true` carries `start_with`, the exact call that starts it (`confirm_stories { proposal, stories,
   decided_by: "manager" }`): make that call, unless step 1 or 2 already started it, and say so in one line. A story
   that is not ready says what it is parked on (`parked_on`): the stories it waits for, a paused work order, the
   person's "proceed?" (where the factory says to ask, it goes in your one "proceed?" list), or that a person put it
   there by hand (theirs to start: ask before you move it). Tell the person which are parked and on what, in one
   short list; `say` counts them. When `backlog.next_offset` is present, request the next page with
   `manager_brief { factory, backlog_offset: backlog.next_offset }` in the same workflow scope.
   Continue until `backlog.next_offset` is null. The proposed drawer contains unplaced stories.
   A configured station named Backlog holds stories already on the board. No `backlog` in the brief (an older CodeBook): read the board's Backlog
   (`factory_board { factory, backlog_offset: 0 }`, then `backlog.next_offset`) for a card that is ready. Ready
   means: not marked "Proposed", waiting for no other story and no person, and nobody working it. A story a person
   wrote is shown and asked about first, at every level.

Which of several ready stories goes first is yours to decide (rule 2): the Backlog's own order, except where two
touch the same files.

The limits hold: `you.on_my_computer.limit`, each station's `parallel.cards_at_once`, a paused factory
(`factory_operations`), a work order's ceiling or deadline, and rule 7 (a story another session manages stays with
it). Say what you took in one line: "#58 is Done. Next: #61 'Refund emails', starting at Build."

When nothing is ready, say so in one line with what is waiting and on whom ("Nothing else is ready: #63 waits for
your approval at Review, #64 for #63."), then finish (section 6).
