import sys

sys.path.insert(0, "..")

import pandas as pd

from run import load_rows, run_case

rows = load_rows()
risk = pd.read_csv("../allocator/out/recommended_100k_path.csv")
risk_arm = risk["mode"].eq("ARMS").to_numpy()
print("risk arm hours", int(risk_arm.sum()), "of", len(risk_arm), f"{risk_arm.mean():.1%}")

for vol in (1.0, 1.5, 2.0, 10.0):
    mf = run_case(rows, policy="fee_check", vol30=vol, vol15=2.0)
    w30 = mf["m_weights_p30"].to_numpy()
    n = len(w30)
    state = []
    for i in range(n):
        if risk_arm[i]:
            state.append("ARM")
        elif w30[i] > 1e-9:
            state.append("0.30")
        else:
            state.append("0.05")
    s = pd.Series(state).value_counts(normalize=True)
    cap30 = float((w30 * (~risk_arm)).sum() / n)
    cap05 = float(((1 - w30) * (~risk_arm)).sum() / n)
    caparm = float(risk_arm.mean())
    print(
        f"vol30 {vol:4.1f}x  end_w30 {w30[-1]:.1%}  any30 {(w30>1e-9).mean():.1%}"
        f"  time ARM {s.get('ARM',0):.1%} 0.30 {s.get('0.30',0):.1%} 0.05 {s.get('0.05',0):.1%}"
        f"  capital ARM {caparm:.1%} 0.30 {cap30:.1%} 0.05 {cap05:.1%}"
    )
