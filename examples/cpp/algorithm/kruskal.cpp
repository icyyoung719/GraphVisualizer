#include "../graphdyvis_export.hpp"

#include <algorithm>
#include <cstddef>
#include <fstream>
#include <iostream>
#include <numeric>
#include <random>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace {

struct DemoConfig {
  int clusters = 4;
  int width = 5;
  unsigned seed = 37;
};

struct NodeSpec {
  std::string id;
  int x = 0;
  int y = 0;
};

struct EdgeSpec {
  std::string id;
  std::string u;
  std::string v;
  int weight = 1;
};

struct DisjointSet {
  std::vector<int> parent;
  std::vector<int> rank;

  explicit DisjointSet(int size) : parent(static_cast<std::size_t>(size)), rank(static_cast<std::size_t>(size), 0) {
    std::iota(parent.begin(), parent.end(), 0);
  }

  int find(int x) {
    if (parent[static_cast<std::size_t>(x)] == x) {
      return x;
    }
    parent[static_cast<std::size_t>(x)] = find(parent[static_cast<std::size_t>(x)]);
    return parent[static_cast<std::size_t>(x)];
  }

  bool unite(int a, int b) {
    a = find(a);
    b = find(b);
    if (a == b) {
      return false;
    }
    if (rank[static_cast<std::size_t>(a)] < rank[static_cast<std::size_t>(b)]) {
      std::swap(a, b);
    }
    parent[static_cast<std::size_t>(b)] = a;
    if (rank[static_cast<std::size_t>(a)] == rank[static_cast<std::size_t>(b)]) {
      rank[static_cast<std::size_t>(a)] += 1;
    }
    return true;
  }
};

std::string makeNodeId(int cluster, int index) {
  std::ostringstream out;
  out << "K" << cluster << "_N" << index;
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
  std::cout << "Usage: kruskal [--clusters=N] [--width=N] [--seed=N] [--output=FILE]\\n";
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
  config.clusters = std::max(3, readIntArg(argc, argv, "--clusters=", config.clusters));
  config.width = std::max(3, readIntArg(argc, argv, "--width=", config.width));
  config.seed = readUnsignedArg(argc, argv, "--seed=", config.seed);
  const std::string outputPath = readStringArg(argc, argv, "--output=", std::string());

  std::vector<NodeSpec> nodes;
  std::vector<EdgeSpec> edges;

  for (int cluster = 0; cluster < config.clusters; ++cluster) {
    for (int index = 0; index < config.width; ++index) {
      nodes.push_back(NodeSpec{
          makeNodeId(cluster, index),
          120 + cluster * 210,
          80 + index * 72,
      });
    }
  }

  std::mt19937 rng(config.seed);
  std::uniform_int_distribution<int> localWeight(1, 4);
  std::uniform_int_distribution<int> bridgeWeight(5, 11);

  auto addEdge = [&](const std::string& a, const std::string& b, int weight) {
    edges.push_back(EdgeSpec{makeEdgeId(a, b), a, b, weight});
  };

  for (int cluster = 0; cluster < config.clusters; ++cluster) {
    for (int left = 0; left < config.width; ++left) {
      for (int right = left + 1; right < config.width; ++right) {
        addEdge(makeNodeId(cluster, left), makeNodeId(cluster, right), localWeight(rng));
      }
    }
  }

  for (int cluster = 0; cluster + 1 < config.clusters; ++cluster) {
    for (int index = 0; index < config.width; ++index) {
      addEdge(
          makeNodeId(cluster, index),
          makeNodeId(cluster + 1, index),
          bridgeWeight(rng));
      if (index + 1 < config.width) {
        addEdge(
            makeNodeId(cluster, index),
            makeNodeId(cluster + 1, index + 1),
            bridgeWeight(rng) + 1);
      }
    }
  }

  std::unordered_map<std::string, int> nodeIndexById;
  for (std::size_t index = 0; index < nodes.size(); ++index) {
    nodeIndexById.emplace(nodes[index].id, static_cast<int>(index));
  }

  std::vector<int> order(edges.size());
  std::iota(order.begin(), order.end(), 0);
  std::sort(order.begin(), order.end(), [&](int left, int right) {
    const auto& a = edges[static_cast<std::size_t>(left)];
    const auto& b = edges[static_cast<std::size_t>(right)];
    if (a.weight != b.weight) {
      return a.weight < b.weight;
    }
    return a.id < b.id;
  });

  graphdyvis::exporter::Document document;
  for (const auto& node : nodes) {
    graphdyvis::exporter::Node outNode;
    outNode.id = node.id;
    outNode.label = node.id;
    outNode.x = node.x;
    outNode.y = node.y;
    outNode.properties.push_back(graphdyvis::exporter::stringProperty("algorithm", "kruskal"));
    document.nodes.push_back(std::move(outNode));
  }

  for (const auto& edge : edges) {
    graphdyvis::exporter::Edge outEdge;
    outEdge.id = edge.id;
    outEdge.source = edge.u;
    outEdge.target = edge.v;
    outEdge.label = std::to_string(edge.weight);
    outEdge.weight = edge.weight;
    outEdge.includeWeight = true;
    outEdge.properties.push_back(graphdyvis::exporter::stringProperty("kind", "undirected"));
    document.edges.push_back(std::move(outEdge));
  }

  DisjointSet dsu(static_cast<int>(nodes.size()));
  int timestampMs = 650;
  int componentsRemaining = static_cast<int>(nodes.size());
  int selectedEdges = 0;

  for (int edgePos : order) {
    const auto& edge = edges[static_cast<std::size_t>(edgePos)];
    const int u = nodeIndexById.at(edge.u);
    const int v = nodeIndexById.at(edge.v);

    graphdyvis::exporter::Event event;
    event.includeTimestamp = true;
    event.timestampMs = timestampMs;
    event.id = edge.id;

    if (dsu.unite(u, v)) {
      selectedEdges += 1;
      componentsRemaining -= 1;
      event.eventType = "edge_update";
      event.reason = "Kruskal accepted this edge because it links two different components.";
      event.newProperties.push_back(graphdyvis::exporter::stringProperty("status", "mst"));
      event.newProperties.push_back(graphdyvis::exporter::intProperty("selectedEdges", selectedEdges));
      event.newProperties.push_back(graphdyvis::exporter::intProperty("componentsRemaining", componentsRemaining));
    } else {
      event.eventType = "edge_delete";
      event.reason = "Kruskal rejected this edge because it forms a cycle.";
    }

    document.events.push_back(std::move(event));
    timestampMs += 180;
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
    std::cerr << "Failed to write Kruskal demo JSON.\n";
    return 1;
  }

  return 0;
}
