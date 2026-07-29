# Email Review Save Button Design

## Goal

Do not show a Save button for a pending email expense that cannot pass the
existing confirmation validation.

## Behavior

- Confirmable expenses and all income transactions keep Save.
- Expenses with a missing or unknown merchant hide Save.
- Expenses with a missing, `Uncategorized`, or `Unknown` category hide Save.
- Edit Details, Change Category, and Cancel remain available.
- The backend confirmation guard remains unchanged so stale callbacks cannot
  bypass validation.

## Implementation

Use one shared confirmability decision for both the existing confirmation guard
and email review keyboard construction. Apply it to deterministic and AI-created
pending email reviews without changing callback names or n8n ownership.

## Tests

Verify that:

- a valid expense review includes Save;
- an unresolved merchant hides Save;
- an unresolved category hides Save;
- an income review includes Save;
- direct confirmation of invalid expenses remains rejected.

## Scope

No database, endpoint, callback format, n8n workflow, or deployment changes.
