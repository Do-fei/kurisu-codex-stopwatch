# StopWatch CodexBar Parity

V2 treats the StopWatch as a compact CodexBar view. The small screen should not invent usage math; it should expose the same sources with only layout and alert compression changed.

## Sources

- Quota windows come from Codex app-server `account/rateLimits/read`.
- The 5 hour window is the 300 minute `primary` window.
- The weekly window is the 10080 minute `secondary` window.
- TODAY tokens prefer the CodexBar widget snapshot at `~/Library/Group Containers/Y5PE65HELJ.com.steipete.codexbar/widget-snapshot.json`.
- If the widget snapshot is unavailable, TODAY falls back to the CodexBar cost cache at `~/Library/Caches/CodexBar/cost-usage/codex-v8.json`.
- Session logs are only the final fallback for TODAY and are still counted with CodexBar-style input plus output token math.

## StopWatch Fields

- `primaryUsedPercent`, `primaryRemainingPercent`, `primaryWindowMinutes`: 5 hour quota.
- `secondaryUsedPercent`, `secondaryRemainingPercent`, `secondaryWindowMinutes`: weekly quota.
- `todayTokens`, `todayTurns`: today's CodexBar-aligned token usage.
- `todayCostUSD`: today's CodexBar-aligned estimated cost when CodexBar exposes it.
- `sessionTokens`, `lastTurnTokens`, `contextWindow`: current conversation context retained for diagnostics.
- `primaryQuotaState`, `secondaryQuotaState`: `normal`, `warn`, `critical`, or `unknown`.
- `quotaAlert`, `quotaAlertLabel`: compact alert state for the firmware footer and haptic cue.

## Alert Policy

- `normal`: below 70 percent used.
- `warn`: 70 percent to below 90 percent used.
- `critical`: 90 percent or more used.
- If both quota windows are high, the bridge reports the highest severity. For ties it reports the more-used window.

## Verification

Run these before calling V2 done:

```sh
npm run check
```

After firmware upload, check `/codex-stopwatch/state` and the device:

- QUOTA shows the same 5 hour and weekly percentages as CodexBar.
- TODAY shows the same token total as CodexBar.
- COST shows CodexBar's today cost and keeps today's token total as supporting context.
- The Usage footer says `CodexBar synced` when CodexBar cache data is active.
- High quota states show a compact footer alert and vibrate only when the state escalates.
