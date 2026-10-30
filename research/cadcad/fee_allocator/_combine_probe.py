import sys

sys.path.insert(0, "..")

import numpy as np
import pandas as pd

from run import load_rows, run_case

risk = pd.read_csv("../allocator/out/recommended_100k_path.csv")
base = pd.read_csv("../allocator/out/comparison_100k_paths.csv")
rows = load_rows()
hodl = base["hold_nvda"].to_numpy()
nav_risk = risk["nav"].to_numpy()
fee_risk = risk["cum_fees"].to_numpy()

for vol, path in ((1.5, "../allocator/out/lp_030_15x.csv"), (2.0, "../allocator/out/lp_030_2x.csv")):
    p30 = pd.read_csv(path)
    nav30 = p30["nav"].to_numpy()
    fee30 = p30["cum_fees"].to_numpy()
    mf = run_case(rows, policy="fee_check", vol30=vol, vol15=2.0)
    w = mf["m_weights_p30"].to_numpy()
    nav = (1 - w) * nav_risk + w * nav30
    fees = np.zeros_like(nav)
    dr = np.diff(fee_risk, prepend=0.0)
    d30 = np.diff(fee30, prepend=0.0)
    for i in range(1, len(nav)):
        fees[i] = fees[i - 1] + (1 - w[i]) * dr[i] + w[i] * d30[i]
    dd = nav / np.maximum.accumulate(nav) - 1
    print(
        f"vol {vol} final {nav[-1]:,.2f} net {nav[-1]-hodl[-1]:+,.2f} "
        f"fees {fees[-1]:,.2f} il {nav[-1]-hodl[-1]-fees[-1]:+,.2f} "
        f"maxdd {dd.min():.2%} avgw {w.mean():.2%} endw {w[-1]:.2%}"
    )
