#!/usr/bin/env python3
"""Run the stage-strength sweep. Thin alias for `tools/probe.py sweep-auto`,
kept because the ledger claims name this path."""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.exit(subprocess.call([sys.executable, os.path.join(HERE, "probe.py"), "sweep-auto"]))
