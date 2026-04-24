#include "../graphdyvis_export.hpp"

#include <algorithm>
#include <cstddef>
#include <fstream>
#include <iostream>
#include <limits>
#include <queue>
#include <random>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace {

struct DemoConfig {
  int clusters = 4;
  int width = 5;
  unsigned seed = 31;
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

std::string makeNodeId(int cluster, int index) {
  std::ostringstream out;
  out << "C" << cluster << "_N" << index;
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
  std::cout << "Usage: prim [--clusters=N] [--width=N] [--seed=N] [--output=FILE]\\n";
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
          80 + index * 75,
      });
    }
  }

  std::mt19937 rng(config.seed);
  std::uniform_int_distribution<int> localWeight(1, 5);
  std::uniform_int_distribution<int> bridgeWeight(5, 12);

  auto addEdge = [&](const std::string& a, const std::string& b, int weight) {
    edges.push_back(EdgeSpec{makeEdgeId(a, b), a, b, weight});
  };

  for (int cluster = 0; cluster < config.clusters; ++cluster) {
    for (int left = 0; left < config.width; ++left) {
      for (int right = left + 1; right < config.width; ++right) {
        const std::string a = makeNodeId(cluster, left);
        const std::string b = makeNodeId(cluster, right);
        addEdge(a, b, localWeight(rng));
      }
    }
  }

  for (int cluster = 0; cluster + 1 < config.clusters; ++cluster) {
    for (int index = 0; index < config.width; ++index) {
      const std::string a = makeNodeId(cluster, index);
      const std::string b = makeNodeId(cluster + 1, index);
      addEdge(a, b, bridgeWeight(rng));
      if (index + 1 < config.width) {
        addEdge(a, makeNodeId(cluster + 1, index + 1), bridgeWeight(rng) + 1);
      }
    }
  }

  std::unordered_map<std::string, int> nodeIndexById;
  for (std::size_t index = 0; index < nodes.size(); ++index) {
    nodeIndexById.emplace(nodes[index].id, static_cast<int>(index));
  }

  struct AdjEdge {
    int to = -1;
    int edgeIndex = -1;
  };

  std::vector<std::vector<AdjEdge>> adjacency(nodes.size());
  for (std::size_t edgeIndex = 0; edgeIndex < edges.size(); ++edgeIndex) {
    const auto& edge = edges[edgeIndex];
    const int u = nodeIndexById.at(edge.u);
    const int v = nodeIndexById.at(edge.v);
    adjacency[u].push_back(AdjEdge{v, static_cast<int>(edgeIndex)});
    adjacency[v].push_back(AdjEdge{u, static_cast<int>(edgeIndex)});
  }

  graphdyvis::exporter::Document document;
  for (const auto& node : nodes) {
    graphdyvis::exporter::Node outNode;
    outNode.id = node.id;
    outNode.label = node.id;
    outNode.x = node.x;
    outNode.y = node.y;
    outNode.properties.push_back(graphdyvis::exporter::stringProperty("algorithm", "prim"));
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

  struct QueueItem {
    int weight = 0;
    int node = -1;
    int edgeIndex = -1;
    bool operator>(const QueueItem& other) const {
      return weight > other.weight;
    }
  };

  std::vector<bool> inTree(nodes.size(), false);
  std::priority_queue<QueueItem, std::vector<QueueItem>, std::greater<QueueItem>> pq;
  std::unordered_set<std::string> mstEdges;

  const int start = 0;
  inTree[start] = true;
  for (const AdjEdge& adj : adjacency[start]) {
    pq.push(QueueItem{edges[static_cast<std::size_t>(adj.edgeIndex)].weight, adj.to, adj.edgeIndex});
  }

  int step = 0;
  int totalWeight = 0;
  int timestampMs = 600;

  while (!pq.empty() && mstEdges.size() + 1 < nodes.size()) {
    const QueueItem candidate = pq.top();
    pq.pop();
    if (inTree[candidate.node]) {
      continue;
    }

    inTree[candidate.node] = true;
    const auto& edge = edges[static_cast<std::size_t>(candidate.edgeIndex)];
    mstEdges.insert(edge.id);
    totalWeight += edge.weight;

    graphdyvis::exporter::Event event;
    event.eventType = "edge_update";
    event.id = edge.id;
    event.includeTimestamp = true;
    event.timestampMs = timestampMs;
    event.reason = "Prim selected the lightest edge crossing the current frontier.";
    event.newProperties.push_back(graphdyvis::exporter::stringProperty("status", "mst"));
    event.newProperties.push_back(graphdyvis::exporter::intProperty("step", step));
    event.newProperties.push_back(graphdyvis::exporter::intProperty("totalWeight", totalWeight));
    document.events.push_back(std::move(event));
    timestampMs += 240;
    step += 1;

    for (const AdjEdge& adj : adjacency[candidate.node]) {
      if (!inTree[adj.to]) {
        pq.push(QueueItem{edges[static_cast<std::size_t>(adj.edgeIndex)].weight, adj.to, adj.edgeIndex});
      }
    }
  }

  for (const auto& edge : edges) {
    if (mstEdges.find(edge.id) != mstEdges.end()) {
      continue;
    }

    graphdyvis::exporter::Event event;
    event.eventType = "edge_delete";
    event.id = edge.id;
    event.includeTimestamp = true;
    event.timestampMs = timestampMs;
    event.reason = "Non-tree edge hidden after Prim finalized the spanning tree.";
    document.events.push_back(std::move(event));
    timestampMs += 150;
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
    std::cerr << "Failed to write Prim demo JSON.\n";
    return 1;
  }

  return 0;
}
