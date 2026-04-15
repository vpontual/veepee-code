# Benchmark Predictions — YYYY-MM-DD

Authored **before** running the benchmark. Compare against actual results afterwards.
Miss rate > 30% → the benchmark, the predictions, or both are off. See §P5.

## Participating models
- List every model you're about to benchmark.
- Note which slot is the **negative control** (expected to rank last-ish).

## Expected ranking (top → bottom)
1. ...
2. ...
3. ...
N. ...

## Specific predictions
- [ ] `<model>` passes multi-turn `calculator-incremental`
- [ ] `<model>` fails multi-turn `bugfix-followup` (known weakness in X)
- [ ] Negative control `<model>` ranks in bottom 3
- [ ] No two top-3 models tie at 100/100 on any category

## Post-run compare (fill in after benchmark)

| Prediction | Actual | Hit? |
|---|---|---|
| ... | ... | ✅/❌ |

### Miss rate
- Hits: N / Total predictions: M → X%
- If > 30%: investigate whether the benchmark needs harder tests (P7) or predictions were uncalibrated.
