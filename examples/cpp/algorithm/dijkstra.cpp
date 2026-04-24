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
#include <utility>
#include <vector>

namespace {

struct DemoConfig {
  int regions = 4;
  int hubsPerRegion = 5;
  unsigned seed = 29;
};

struct NodeSpec {
  std::string id;
  int x = 0;
  int y = 0;
};

struct EdgeSpec {
  std::string id;
  std::string source;
  std::string target;
  int weight = 1;
};

std::string makeNodeId(int region, int hub) {
  std::ostringstream out;
  out << "R" << region << "_H" << hub;
  return out.str();
}

std::string makeEdgeId(const std::string& source, const std::string& target) {
  return source + "->" + target;
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
  std::cout << "Usage: dijkstra [--regions=N] [--hubs=N] [--seed=N] [--output=FILE]\\n";
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
  config.regions = std::max(3, readIntArg(argc, argv, "--regions=", config.regions));
  config.hubsPerRegion = std::max(3, readIntArg(argc, argv, "--hubs=", config.hubsPerRegion));
  config.seed = readUnsignedArg(argc, argv, "--seed=", config.seed);
  const std::string outputPath = readStringArg(argc, argv, "--output=", std::string());

  std::vector<NodeSpec> nodes;
  std::vector<EdgeSpec> edges;

  const std::string sourceId = "SOURCE";
  const std::string targetId = "TARGET";

  nodes.push_back(NodeSpec{sourceId, 80, 200});
  for (int region = 0; region < config.regions; ++region) {
    for (int hub = 0; hub < config.hubsPerRegion; ++hub) {
      nodes.push_back(NodeSpec{
          makeNodeId(region, hub),
          240 + region * 180,
          60 + hub * 70,
      });
    }
  }
  nodes.push_back(NodeSpec{targetId, 240 + config.regions * 180, 200});

  std::mt19937 rng(config.seed);
  std::uniform_int_distribution<int> fastWeight(1, 4);
  std::uniform_int_distribution<int> slowWeight(6, 13);

  for (int hub = 0; hub < config.hubsPerRegion; ++hub) {
    const std::string to = makeNodeId(0, hub);
    const bool preferred = hub == 0;
    const int weight = preferred ? fastWeight(rng) : slowWeight(rng);
    edges.push_back(EdgeSpec{makeEdgeId(sourceId, to), sourceId, to, weight});
  }

  for (int region = 0; region + 1 < config.regions; ++region) {
    for (int fromHub = 0; fromHub < config.hubsPerRegion; ++fromHub) {
      const std::string from = makeNodeId(region, fromHub);
      for (int toHub = 0; toHub < config.hubsPerRegion; ++toHub) {
        const std::string to = makeNodeId(region + 1, toHub);
        const bool preferred = fromHub == 0 && toHub == 0;
        const int weight = preferred ? fastWeight(rng) : slowWeight(rng);
        edges.push_back(EdgeSpec{makeEdgeId(from, to), from, to, weight});
      }

      if (region + 2 < config.regions) {
        const std::string expressTarget = makeNodeId(region + 2, 0);
        edges.push_back(EdgeSpec{makeEdgeId(from, expressTarget), from, expressTarget, slowWeight(rng) + 3});
      }
    }
  }

  for (int hub = 0; hub < config.hubsPerRegion; ++hub) {
    const std::string from = makeNodeId(config.regions - 1, hub);
    const bool preferred = hub == 0;
    const int weight = preferred ? fastWeight(rng) : slowWeight(rng);
    edges.push_back(EdgeSpec{makeEdgeId(from, targetId), from, targetId, weight});
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
    const int from = nodeIndexById.at(edge.source);
    const int to = nodeIndexById.at(edge.target);
    adjacency[from].push_back(AdjEdge{to, static_cast<int>(edgeIndex)});
  }

  const int start = nodeIndexById.at(sourceId);
  const int goal = nodeIndexById.at(targetId);
  const int inf = std::numeric_limits<int>::max() / 4;

  std::vector<int> dist(nodes.size(), inf);
  std::vector<int> parentEdge(nodes.size(), -1);
  std::vector<bool> settled(nodes.size(), false);

  struct QueueItem {
    int distance = 0;
    int node = 0;
    bool operator>(const QueueItem& other) const {
      return distance > other.distance;
    }
  };

  std::priority_queue<QueueItem, std::vector<QueueItem>, std::greater<QueueItem>> pq;
  dist[start] = 0;
  pq.push(QueueItem{0, start});

  int timestampMs = 500;
  graphdyvis::exporter::Document document;

  for (const auto& node : nodes) {
    graphdyvis::exporter::Node outNode;
    outNode.id = node.id;
    outNode.label = node.id;
    outNode.x = node.x;
    outNode.y = node.y;
    outNode.properties.push_back(graphdyvis::exporter::stringProperty("algorithm", "dijkstra"));
    document.nodes.push_back(std::move(outNode));
  }

  for (const auto& edge : edges) {
    graphdyvis::exporter::Edge outEdge;
    outEdge.id = edge.id;
    outEdge.source = edge.source;
    outEdge.target = edge.target;
    outEdge.label = std::to_string(edge.weight);
    outEdge.weight = edge.weight;
    outEdge.includeWeight = true;
    outEdge.properties.push_back(graphdyvis::exporter::stringProperty("lane", "candidate"));
    document.edges.push_back(std::move(outEdge));
  }

  while (!pq.empty()) {
    const QueueItem current = pq.top();
    pq.pop();

    if (settled[current.node]) {
      continue;
    }
    settled[current.node] = true;

    if (current.node != start && parentEdge[current.node] >= 0) {
      const auto& chosen = edges[static_cast<std::size_t>(parentEdge[current.node])];
      graphdyvis::exporter::Event event;
      event.eventType = "edge_update";
      event.id = chosen.id;
      event.includeTimestamp = true;
      event.timestampMs = timestampMs;
      event.reason = "Dijkstra settled a frontier node through this minimum-cost edge.";
      event.newProperties.push_back(graphdyvis::exporter::stringProperty("status", "settled"));
      event.newProperties.push_back(graphdyvis::exporter::intProperty("distance", dist[current.node]));
      document.events.push_back(std::move(event));
      timestampMs += 280;
    }

    if (current.node == goal) {
      break;
    }

    for (const AdjEdge& adj : adjacency[current.node]) {
      const auto& edge = edges[static_cast<std::size_t>(adj.edgeIndex)];
      if (dist[current.node] + edge.weight < dist[adj.to]) {
        dist[adj.to] = dist[current.node] + edge.weight;
        parentEdge[adj.to] = adj.edgeIndex;
        pq.push(QueueItem{dist[adj.to], adj.to});
      }
    }
  }

  std::unordered_set<std::string> shortestPathEdges;
  int walk = goal;
  while (walk != start && parentEdge[walk] >= 0) {
    const auto& edge = edges[static_cast<std::size_t>(parentEdge[walk])];
    shortestPathEdges.insert(edge.id);
    walk = nodeIndexById.at(edge.source);
  }

  for (const auto& edge : edges) {
    if (shortestPathEdges.find(edge.id) != shortestPathEdges.end()) {
      continue;
    }

    graphdyvis::exporter::Event event;
    event.eventType = "edge_delete";
    event.id = edge.id;
    event.includeTimestamp = true;
    event.timestampMs = timestampMs;
    event.reason = "Removed from shortest-path tree visualization to reduce clutter.";
    document.events.push_back(std::move(event));
    timestampMs += 160;
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
    std::cerr << "Failed to write Dijkstra demo JSON.\n";
    return 1;
  }

  return 0;
}
