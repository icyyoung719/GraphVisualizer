# C++ A* Demo

This folder contains a lightweight C++17 example that emits GraphDyVis-compatible JSON for visualization testing.

## Files

- `graphdyvis_astar.hpp`: header-only demo library
- `astar_demo.cpp`: minimal CLI that writes JSON to stdout or a file
- `graphdyvis_workflow.hpp`: layered service-flow demo for aggregation testing
- `workflow_demo.cpp`: CLI for the workflow demo generator

## Build

Any C++17 compiler should work. Example with MSVC from the repository root:

```powershell
cl /std:c++17 /EHsc /I . examples\cpp\astar_demo.cpp
```

Example with GCC or Clang:

```bash
g++ -std=c++17 -O2 -I . examples/cpp/astar_demo.cpp -o astar_demo
```

## Generate a sample file

Run the demo with parameters to control graph size and randomness:

```powershell
.\astar_demo.exe --layers=6 --width=4 --seed=17 --output=data\astar-sample-events.json
```

Useful knobs:

- `--layers=N`: increases the number of graph layers and event depth
- `--width=N`: increases the number of nodes per layer
- `--seed=N`: changes the deterministic edge weights
- `--output=FILE`: writes the JSON to a file instead of stdout

Generate the richer aggregation-oriented sample:

```powershell
.\workflow_demo.exe --domains=4 --services=6 --seed=23 --output=data\aggregation-sample-events.json
```

Workflow knobs:

- `--domains=N`: number of domain layers in the flow
- `--services=N`: number of services per domain layer
- `--seed=N`: deterministic branch weight pattern
- `--output=FILE`: writes JSON to file (otherwise stdout)