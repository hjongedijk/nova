# Personal Node-RED routines

NOVA can turn a plain-language request such as “remind me every day at 07:45 to
put the bin outside” into a personal daily reminder. It adds a fixed Node-RED
schedule, a fixed message formatter and the NOVA notification node to an
explicitly mapped flow. The reminder text is saved with the flow and delivered
through NOVA's normal notification settings.

Creating a routine requires a fresh DANGEROUS confirmation that shows its
message and time. NOVA only writes these fixed nodes; it never generates
JavaScript or arbitrary Node-RED node definitions. A valid Node-RED admin token,
event token and mapped flow tab are required. The schedule uses the host's
configured timezone.

This first routine type supports a daily time trigger and a NOVA notification
action. Existing fixed flow templates also support catchable errors, offline
node status and briefings. Arbitrary event/action combinations are not
available yet. Routine text is omitted from durable action logs; deleting a
routine can be done from the flow in Node-RED.
