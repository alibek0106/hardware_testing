# NOTES

## Task 2 — Signal quality (status codes, timestamps and anomaly detection)

Spec: [tests/opcua/signal-quality.spec.ts](tests/opcua/signal-quality.spec.ts) plus the
device-free detector unit tests in
[tests/opcua/signal-analysis-unit.spec.ts](tests/opcua/signal-analysis-unit.spec.ts). The
`signalRig` fixture composes the Task 1 `deviceRig`, so the fast-node updates stopped by the
frozen-signal test are restored by the same teardown (`StartUpdateFastNodes`), also after a
failed test.

### Wrapper surface

`readDataValue()` returns value, status code and both timestamps **without** throwing on
non-Good quality (Bad/Uncertain data is the subject of these tests); `requireGood()` restores
fail-fast semantics by returning the value only for Good status and throwing the typed
`OpcUaOperationError` otherwise; `monitor()` returns a collector with awaitable
`take(count, timeoutMs)` and window-bounded `collectDuring(windowMs)`; `isStale(dataValue,
maxAgeMs)` judges staleness from the source timestamp. Spec files receive plain objects only.

### Tolerances and timeouts (stated, with sources)

- **Sampling rate (step 2):** nominal fast-node period 1 s (from the simulator's `--fr=1`
  flag in [compose.yml](compose.yml)); per-interval tolerance **±20%** — the simulator
  schedules updates on its 100 ms simulation-cycle grid and notifications ride on a
  100 ms publishing interval, so up to ±200 ms of combined jitter is expected without any
  sample being lost. A separate bound of **2 periods** (2 s) marks a lost sample.
- **Quality classes (step 3):** timeout **30 s** for one Good, one Uncertain and one Bad
  notification — a wide multiple of the 1 s update period of the status-cycling node, so the
  test outlives several full status cycles.
- **Frozen signal (step 4):** `maxAgeMs` = **3 s** (three nominal periods — one missing update
  is jitter, three is a stall). The running baseline is established with `expect.poll` until a
  fresh value arrives, because a directly preceding repeat of this test leaves the node stalled
  and `StartUpdateFastNodes` needs up to one period to take effect — a one-shot freshness check
  would race the restart under `--repeat-each=3`. The test asserts that the **source
  timestamp** is the one that freezes (it is the device-side stamp of the last real update; two
  consecutive reads of the stalled node must return the identical source timestamp) and records
  the observed frozen status code and both timestamps in the `frozen-signal-evidence`
  attachment of every run, including failed ones (the attachment happens in a `finally`).
- **Anomalies (step 5):** one simulation phase is 50 cycles × 100 ms = 5 s (opc-plc default);
  the collection window is **25 s ≥ 4 phases** plus margin. Sampling interval **50 ms** is half
  the 100 ms simulation cycle, so a one-cycle anomaly is always sampled at least once, and the
  **queue size of 100** holds more than one publishing interval's worth of 50 ms samples, so
  nothing is discarded between publishes. Detection threshold: |value| beyond **1.5×** the
  nominal amplitude, where the amplitude is the 90th percentile of |value| derived from the
  collected data itself (robust against the rare anomaly samples) — normal sine peaks stay
  ≈1.05× that estimate, anomalies are far beyond it.
- **Deadband (step 6):** the deadband is derived, not assumed: **3× the median absolute step**
  between consecutive unfiltered samples of a calibration phase — larger than the change
  between two samples, and asserted smaller than the anomaly floor (1.5× nominal amplitude).
  Both monitored items observe the same **11 s window (2 phases + margin)** concurrently, so
  at least one anomaly falls inside it. The filtered item's creation status is asserted Good;
  if a server rejected the filter, that assertion fails by design and surfaces the rejection.

### Evidence

Every device test attaches its samples and derived figures (`sampling-rate-intervals`,
`status-class-notifications`, `frozen-signal-evidence`, `anomaly-detections`,
`deadband-calibration`, `deadband-window`) via `testInfo.attach()`. The spike/dip detectors
are pure functions in [src/opcua/SignalAnalysis.ts](src/opcua/SignalAnalysis.ts) and are
unit-tested against synthetic sine arrays with no device connected.

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
