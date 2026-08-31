# Engineering decisions

Material cross-module decisions live in one lifecycle directory:

- `proposed`: designed or locally implemented, but missing required deployment or field evidence;
- `implemented`: fully implemented and verified at every boundary required by the record;
- `rejected`: retained only when the rejection prevents a plausible future mistake.

Files use `yyyy-mm-dd-lowercase-topic.md`. Move the same file between lifecycle directories when its status changes; do not keep duplicate copies.

Each record must use the lifecycle-appropriate sections and identify its problem, chosen proposal or decision, alternatives, consequences or risks, verification boundary, and rollback.
