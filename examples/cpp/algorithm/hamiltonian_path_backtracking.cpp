#include "../graphdyvis_export.hpp"

#include <algorithm>
#include <cstddef>
#include <fstream>
#include <iostream>
#include <map>
#include <random>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace {

struct DemoConfig {
  int layers = 4;
  int width = 3;
  unsigned seed = 43;
};

struct NodeSpec {
  std::string id;
  int x = 0;
  int y = 0;
};

struct EdgeSpec {
  std::string id;
  int u = -1;
  int v = -1;
};

struct BacktrackingContext {
  std::vector<std::vector<int>> adjacency;
  std::vector<EdgeSpec> edges;
  std::vector<bool> visited;
  std::vector<int> path;
  std::vector<int> chosenEdgeIndices;
  std::unordered_set<std::string> finalPathEdges;
  graphdyvis::exporter::Document* document = nullptr;
  int timestampMs = 800;
  int backtrackCount = 0;
};

std::string makeNodeId(int layer, int index) {
  std::ostringstream out;
  out << "H" << layer << "_" << index;
  return out.str();
}

std::string makeEdgeId(const std::string& a, const std::string& b) {
  return a < b ? a + "--" + b : b + "--" + a;
}

int readIntArg(int argc, char** argv, std::string_view prefix, int defaultValue) {
  for (int index = 1; index < argc; ++index) {
    const std::string_view arg(argv[index]);
    if (arg.rfind(prefix, 0) == 0) {
      try {
        return std::stoi(std::string(arg.substr(prefix.size())));
      } catch (...) {
        return defaultValue;
      }
    }
  }
  return defaultValue;
}

unsigned readUnsignedArg(int argc, char** argv, std::string_view prefix, unsigned defaultValue) {
  for (int index = 1; index < argc; ++index) {
    const std::string_view arg(argv[index]);
    if (arg.rfind(prefix, 0) == 0) {
      try {
        return static_cast<unsigned>(std::stoul(std::string(arg.substr(prefix.size()))));
      } catch (...) {
        return defaultValue;
      }
    }
  }
  return defaultValue;
}

std::string readStringArg(int argc, char** argv, std::string_view prefix, std::string defaultValue) {
  for (int index = 1; index < argc; ++index) {
    const std::string_view arg(argv[index]);
    if (arg.rfind(prefix, 0) == 0) {
      return std::string(arg.substr(prefix.size()));
    }
  }
  return defaultValue;
}

void printUsage() {
  std::cout << "Usage: hamiltonian_path_backtracking [--layers=N] [--width=N] [--seed=N] [--output=FILE]\\n";
}

}  // namespace

int main(int argc, char** argv) {
  for (int index = 1; index < argc; ++index) {
    if (std::string_view(argv[index]) == "--help") {
      printUsage();
      return 0;
    }
  }

  DemoConfig config;
  config.layers = std::max(3, readIntArg(argc, argv, "--layers=", config.layers));
  config.width = std::max(3, readIntArg(argc, argv, "--width=", config.width));
  config.seed = readUnsignedArg(argc, argv, "--seed=", config.seed);
  const std::string outputPath = readStringArg(argc, argv, "--output=", std::string());

  const int nodeCount = config.layers * config.width;
  std::vector<NodeSpec> nodes;
  nodes.reserve(static_cast<std::size_t>(nodeCount));

  for (int layer = 0; layer < config.layers; ++layer) {
    for (int index = 0; index < config.width; ++index) {
      nodes.push_back(NodeSpec{
          makeNodeId(layer, index),
          140 + layer * 200,
          90 + index * 110,
      });
    }
  }

  std::vector<EdgeSpec> edges;
  std::map<std::pair<int, int>, int> edgeIndexByPair;

  auto addUndirectedEdge = [&](int a, int b) {
    if (a == b) {
      return;
    }
    const int low = std::min(a, b);
    const int high = std::max(a, b);
    const std::pair<int, int> key(low, high);
    if (edgeIndexByPair.find(key) != edgeIndexByPair.end()) {
      return;
    }
    const std::string edgeId = makeEdgeId(nodes[static_cast<std::size_t>(a)].id, nodes[static_cast<std::size_t>(b)].id);
    edgeIndexByPair.emplace(key, static_cast<int>(edges.size()));
    edges.push_back(EdgeSpec{edgeId, a, b});
  };

  for (int layer = 0; layer < config.layers; ++layer) {
    for (int index = 0; index + 1 < config.width; ++index) {
      const int a = layer * config.width + index;
      const int b = layer * config.width + index + 1;
      addUndirectedEdge(a, b);
    }
  }

  for (int layer = 0; layer + 1 < config.layers; ++layer) {
    for (int index = 0; index < config.width; ++index) {
      const int a = layer * config.width + index;
      const int b = (layer + 1) * config.width + index;
      addUndirectedEdge(a, b);
      if (index + 1 < config.width) {
        addUndirectedEdge(a, (layer + 1) * config.width + index + 1);
      }
    }
  }

  // Add deterministic cross links that create tempting but often dead-end branches.
  std::mt19937 rng(config.seed);
  std::uniform_int_distribution<int> nodePick(0, nodeCount - 1);
  const int extraEdges = std::max(4, nodeCount / 2);
  for (int i = 0; i < extraEdges; ++i) {
    int a = nodePick(rng);
    int b = nodePick(rng);
    if (std::abs(a - b) <= 1) {
      continue;
    }
    addUndirectedEdge(a, b);
  }

  BacktrackingContext ctx;
  ctx.adjacency.assign(static_cast<std::size_t>(nodeCount), {});
  ctx.edges = edges;
  ctx.visited.assign(static_cast<std::size_t>(nodeCount), false);

  for (std::size_t edgeIndex = 0; edgeIndex < edges.size(); ++edgeIndex) {
    const auto& edge = edges[edgeIndex];
    ctx.adjacency[static_cast<std::size_t>(edge.u)].push_back(static_cast<int>(edgeIndex));
    ctx.adjacency[static_cast<std::size_t>(edge.v)].push_back(static_cast<int>(edgeIndex));
  }

  graphdyvis::exporter::Document document;
  ctx.document = &document;

  for (const auto& node : nodes) {
    graphdyvis::exporter::Node outNode;
    outNode.id = node.id;
    outNode.label = node.id;
    outNode.x = node.x;
    outNode.y = node.y;
    outNode.properties.push_back(graphdyvis::exporter::stringProperty("algorithm", "hamiltonian-backtracking"));
    document.nodes.push_back(std::move(outNode));
  }

  for (const auto& edge : edges) {
    graphdyvis::exporter::Edge outEdge;
    outEdge.id = edge.id;
    outEdge.source = nodes[static_cast<std::size_t>(edge.u)].id;
    outEdge.target = nodes[static_cast<std::size_t>(edge.v)].id;
    outEdge.label = "1";
    outEdge.weight = 1;
    outEdge.includeWeight = true;
    outEdge.properties.push_back(graphdyvis::exporter::stringProperty("kind", "candidate"));
    document.edges.push_back(std::move(outEdge));
  }

  const int startNode = 0;
  const int targetEndNode = nodeCount - 1;

  auto dfs = [&](auto&& self, int node) -> bool {
    if (static_cast<int>(ctx.path.size()) == nodeCount) {
      return node == targetEndNode;
    }

    for (int edgeIndex : ctx.adjacency[static_cast<std::size_t>(node)]) {
      const auto& edge = ctx.edges[static_cast<std::size_t>(edgeIndex)];
      const int next = edge.u == node ? edge.v : edge.u;
      if (ctx.visited[static_cast<std::size_t>(next)]) {
        continue;
      }

      graphdyvis::exporter::Event explore;
      explore.eventType = "edge_update";
      explore.id = edge.id;
      explore.includeTimestamp = true;
      explore.timestampMs = ctx.timestampMs;
      explore.reason = "Backtracking explores this candidate edge.";
      explore.newProperties.push_back(graphdyvis::exporter::stringProperty("status", "explore"));
      explore.newProperties.push_back(graphdyvis::exporter::intProperty("depth", static_cast<int>(ctx.path.size())));
      ctx.document->events.push_back(std::move(explore));
      ctx.timestampMs += 170;

      ctx.visited[static_cast<std::size_t>(next)] = true;
      ctx.path.push_back(next);
      ctx.chosenEdgeIndices.push_back(edgeIndex);

      if (self(self, next)) {
        return true;
      }

      ctx.backtrackCount += 1;
      graphdyvis::exporter::Event backtrack;
      backtrack.eventType = "edge_delete";
      backtrack.id = edge.id;
      backtrack.includeTimestamp = true;
      backtrack.timestampMs = ctx.timestampMs;
      backtrack.reason = "Dead end reached; backtracking removes this attempt from focus.";
      ctx.document->events.push_back(std::move(backtrack));
      ctx.timestampMs += 150;

      ctx.chosenEdgeIndices.pop_back();
      ctx.path.pop_back();
      ctx.visited[static_cast<std::size_t>(next)] = false;
    }

    return false;
  };

  ctx.path.push_back(startNode);
  ctx.visited[static_cast<std::size_t>(startNode)] = true;
  const bool found = dfs(dfs, startNode);

  if (found) {
    for (int edgeIndex : ctx.chosenEdgeIndices) {
      ctx.finalPathEdges.insert(ctx.edges[static_cast<std::size_t>(edgeIndex)].id);
    }

    int step = 0;
    for (int edgeIndex : ctx.chosenEdgeIndices) {
      const auto& edge = ctx.edges[static_cast<std::size_t>(edgeIndex)];
      graphdyvis::exporter::Event lock;
      lock.eventType = "edge_update";
      lock.id = edge.id;
      lock.includeTimestamp = true;
      lock.timestampMs = ctx.timestampMs;
      lock.reason = "Edge confirmed as part of the Hamiltonian path.";
      lock.newProperties.push_back(graphdyvis::exporter::stringProperty("status", "hamiltonian-path"));
      lock.newProperties.push_back(graphdyvis::exporter::intProperty("step", step));
      document.events.push_back(std::move(lock));
      ctx.timestampMs += 190;
      step += 1;
    }
  }

  for (const auto& edge : edges) {
    if (ctx.finalPathEdges.find(edge.id) != ctx.finalPathEdges.end()) {
      continue;
    }

    graphdyvis::exporter::Event remove;
    remove.eventType = "edge_delete";
    remove.id = edge.id;
    remove.includeTimestamp = true;
    remove.timestampMs = ctx.timestampMs;
    remove.reason = found
        ? "Hidden to spotlight the final Hamiltonian path."
        : "No full Hamiltonian path found with this search order.";
    document.events.push_back(std::move(remove));
    ctx.timestampMs += 110;
  }

  if (outputPath.empty()) {
    return graphdyvis::exporter::writeGraphJson(document, std::cout) ? 0 : 1;
  }

  std::ofstream outputFile(outputPath, std::ios::binary);
  if (!outputFile) {
    std::cerr << "Failed to open output file: " << outputPath << '\n';
    return 1;
  }

  const bool ok = graphdyvis::exporter::writeGraphJson(document, outputFile);
  if (!ok) {
    std::cerr << "Failed to write Hamiltonian backtracking demo JSON.\n";
    return 1;
  }

  return 0;
}
