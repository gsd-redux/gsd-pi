# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

`needs-triage` and `needs-info` already exist on `open-gsd/gsd-pi`. The other three (`ready-for-agent`, `ready-for-human`, `wontfix`) will be created on first use:

```bash
gh label create ready-for-agent -R open-gsd/gsd-pi --description "Fully specified, ready for an AFK agent" --color 0E8A16
gh label create ready-for-human -R open-gsd/gsd-pi --description "Requires human implementation" --color 1D76DB
gh label create wontfix         -R open-gsd/gsd-pi --description "Will not be actioned"          --color CCCCCC
```

Edit the right-hand column to match whatever vocabulary you actually use.
