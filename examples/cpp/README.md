# C++ GraphDyVis Export Demos

This folder contains lightweight C++17 demos that emit GraphDyVis-compatible JSON for visualization testing.

## Files

- `graphdyvis_export.hpp`: generic GraphDyVis JSON exporter (algorithm-agnostic)
- `algorithm/astar.cpp`: A* scenario simulator
- `algorithm/workflow.cpp`: layered service-flow simulator for aggregation testing
- `algorithm/dijkstra.cpp`: shortest-path simulation on a weighted network
- `algorithm/prim.cpp`: Prim MST simulation with frontier growth
- `algorithm/kruskal.cpp`: Kruskal MST simulation with cycle rejection
- `algorithm/tsp_nearest_neighbor.cpp`: TSP nearest-neighbor heuristic simulation
- `algorithm/hamiltonian_path_backtracking.cpp`: backtracking-based Hamiltonian path simulation

## Build

Any C++17 compiler should work. Example with MSVC from the repository root:

```powershell
cl /std:c++17 /EHsc /I . examples\cpp\algorithm\astar.cpp
```

Example with GCC or Clang:

```bash
g++ -std=c++17 -O2 -I . examples/cpp/algorithm/astar.cpp -o astar
```

## Generate a sample file

Run the demo with parameters to control graph size and randomness:

```powershell
.\astar.exe --layers=6 --width=4 --seed=17 --output=data\astar-sample-events.json
```

Useful knobs:

- `--layers=N`: increases the number of graph layers and event depth
- `--width=N`: increases the number of nodes per layer
- `--seed=N`: changes the deterministic edge weights
- `--output=FILE`: writes the JSON to a file instead of stdout

Generate the richer aggregation-oriented sample:

```powershell
.\workflow.exe --domains=4 --services=6 --seed=23 --output=data\aggregation-sample-events.json
```

Workflow knobs:

- `--domains=N`: number of domain layers in the flow
- `--services=N`: number of services per domain layer
- `--seed=N`: deterministic branch weight pattern
- `--output=FILE`: writes JSON to file (otherwise stdout)

## Build and generate additional algorithm samples

Use the same pattern to compile and export the additional demos:

```bash
g++ -std=c++17 -O2 -I . examples/cpp/algorithm/dijkstra.cpp -o dijkstra
g++ -std=c++17 -O2 -I . examples/cpp/algorithm/prim.cpp -o prim
g++ -std=c++17 -O2 -I . examples/cpp/algorithm/kruskal.cpp -o kruskal
g++ -std=c++17 -O2 -I . examples/cpp/algorithm/tsp_nearest_neighbor.cpp -o tsp_nearest_neighbor
g++ -std=c++17 -O2 -I . examples/cpp/algorithm/hamiltonian_path_backtracking.cpp -o hamiltonian_path_backtracking
```

```bash
./dijkstra --regions=4 --hubs=5 --seed=29 --output=data/dijkstra-sample-events.json
./prim --clusters=4 --width=5 --seed=31 --output=data/prim-sample-events.json
./kruskal --clusters=4 --width=5 --seed=37 --output=data/kruskal-sample-events.json
./tsp_nearest_neighbor --cities=12 --seed=41 --output=data/tsp-nearest-neighbor-sample-events.json
./hamiltonian_path_backtracking --layers=4 --width=3 --seed=43 --output=data/hamiltonian-path-backtracking-sample-events.json
```