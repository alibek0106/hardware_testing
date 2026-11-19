# NOTES

## Task 1 — Device commands (OPC UA methods and state verification)

Spec: [tests/opcua/device-commands.spec.ts](tests/opcua/device-commands.spec.ts), driven through
the `deviceRig` fixture ([tests/fixtures/device-commands.fixture.ts](tests/fixtures/device-commands.fixture.ts))
which connects, discovers the command surface by browsing, and restores the running state
(`StartStepUp`, `StartUpdateFastNodes`) in teardown — also after a failed test.

### Observed behaviour (recorded, not assumed)

All values observed against `mcr.microsoft.com/iotedge/opc-plc:2.12.48` (the tag pinned in
[compose.yml](compose.yml)):

- **Repeated `StopStepUp` (step 6):** the second call on an already-stopped counter returns
  `Good (0x00000000)` — the simulator treats the command as idempotent rather than rejecting
  it. The test records the status in its `command-log` attachment and asserts only that the
  device is still stopped afterwards.
- **Invalid commands (step 7):** calling a non-existent method node id returns
  `BadMethodInvalid (0x80750000)`; calling `StopStepUp` with the wrong parent object (the
  `OpcPlc` object instead of its `Methods` child) also returns `BadMethodInvalid (0x80750000)`.
  Both surface as the typed `OpcUaOperationError` carrying the status code name.
- **Measured update intervals (step 2):** `StepUp` updates every ~100 ms (source-timestamp
  deltas 98–102 ms); the fast nodes update every ~1 s (`--fr=1`). Each test measures the
  interval from its own baseline samples instead of assuming these numbers.

### Observation windows and tolerances

- **Window length:** `max(1000 ms, 5 × measured update interval)` — the task requires at
  least five update intervals; the 1 s floor keeps the window meaningful for the ~100 ms
  StepUp period (≈10 intervals) so that a single delayed publish cannot produce a false
  "no change" verdict.
- **Settle-before-window:** after a stop command the test first polls until two consecutive
  reads return the same value, then opens the observation window. This drains notifications
  that were already queued in the publish pipeline when the command executed; without it the
  window could report a change that happened before the stop took effect.
- **Initial notification:** a monitored item always delivers the current value once on
  creation. The wrapper's `collectChanges()` / `collectNotifications()` discard that initial
  notification, so an empty `collectChanges()` result genuinely means "no data change".
- **No exact timing or analog equality:** assertions are monotonicity (strictly increasing
  counters), threshold (`> settled value`, `> 0`) and discrete-state equality (two reads of a
  stopped UInt32 counter, prescribed by the task). The measured update interval is recorded
  as evidence, not asserted against a nominal value.

### Device state isolation

The OPC UA tests run with one worker (`workers: 1`, `fullyParallel: false` in
[playwright.config.ts](playwright.config.ts)), so the shared simulator is never commanded by
two tests at once. Every test that stops an actuator gets the running state restored by the
`deviceRig` fixture teardown; the spec passes with `--repeat-each=3` and when any single test
runs alone.

### Evidence

Each device test attaches its baseline samples, the measured interval and derived window, the
observation-window contents and the command log to the Playwright report via
`testInfo.attach()`, so a failed run can be diagnosed without re-running the rig. The
discovery test additionally cross-checks the browsed `StepUp` and fast-node ids against the
simulator's own publisher configuration served at `http://localhost:8080/pn.json` (`--sph`).
