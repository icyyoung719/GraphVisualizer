#include "../graphdyvis_export.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <fstream>
#include <iostream>
#include <limits>
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
  int cities = 12;
  unsigned seed = 41;
};

struct NodeSpec {
  std::string id;
  int x = 0;
  int y = 0;
};

struct EdgeSpec {
  std::string id;
  int a = 0;
  int b = 0;
  int weight = 1;
};

int distanceRounded(const NodeSpec& left, const NodeSpec& right) {
  const int dx = left.x - right.x;
  const int dy = left.y - right.y;
  const double dist = std::sqrt(static_cast<double>(dx * dx + dy * dy));
  return std::max(1, static_cast<int>(std::round(dist / 12.0)));
}

std::string makeNodeId(int city) {
  std::ostringstream out;
  out << "City_" << city;
  return out.str();
}

std::string makeEdgeId(int a, int b) {
  if (a > b) {
    std::swap(a, b);
  }
  std::ostringstream out;
  out << "City_" << a << "--City_" << b;
  return out.str();
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
  std::cout << "Usage: tsp_nearest_neighbor [--cities=N] [--seed=N] [--output=FILE]\\n";
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
  config.cities = std::max(8, readIntArg(argc, argv, "--cities=", config.cities));
  config.seed = readUnsignedArg(argc, argv, "--seed=", config.seed);
  const std::string outputPath = readStringArg(argc, argv, "--output=", std::string());

  std::vector<NodeSpec> nodes;
  nodes.reserve(static_cast<std::size_t>(config.cities));

  std::mt19937 rng(config.seed);
  std::uniform_real_distribution<double> phaseNoise(-0.18, 0.18);
  std::uniform_int_distribution<int> radialNoise(-25, 25);

  const int centerX = 520;
  const int centerY = 290;
  const int radius = 230;

  for (int city = 0; city < config.cities; ++city) {
    const double angle = (2.0 * 3.141592653589793 * city) / config.cities + phaseNoise(rng);
    const int x = centerX + static_cast<int>(std::round(std::cos(angle) * radius)) + radialNoise(rng);
    const int y = centerY + static_cast<int>(std::round(std::sin(angle) * radius)) + radialNoise(rng);
    nodes.push_back(NodeSpec{makeNodeId(city), x, y});
  }

  std::vector<EdgeSpec> edges;
  edges.reserve(static_cast<std::size_t>(config.cities * (config.cities - 1) / 2));
  std::unordered_map<std::string, int> edgeIndexById;

  for (int left = 0; left < config.cities; ++left) {
    for (int right = left + 1; right < config.cities; ++right) {
      const std::string edgeId = makeEdgeId(left, right);
      const int weight = distanceRounded(nodes[static_cast<std::size_t>(left)], nodes[static_cast<std::size_t>(right)]);
      edgeIndexById.emplace(edgeId, static_cast<int>(edges.size()));
      edges.push_back(EdgeSpec{edgeId, left, right, weight});
    }
  }

  graphdyvis::exporter::Document document;
  for (const auto& node : nodes) {
    graphdyvis::exporter::Node outNode;
    outNode.id = node.id;
    outNode.label = node.id;
    outNode.x = node.x;
    outNode.y = node.y;
    outNode.properties.push_back(graphdyvis::exporter::stringProperty("algorithm", "tsp-nearest-neighbor"));
    document.nodes.push_back(std::move(outNode));
  }

  for (const auto& edge : edges) {
    graphdyvis::exporter::Edge outEdge;
    outEdge.id = edge.id;
    outEdge.source = makeNodeId(edge.a);
    outEdge.target = makeNodeId(edge.b);
    outEdge.label = std::to_string(edge.weight);
    outEdge.weight = edge.weight;
    outEdge.includeWeight = true;
    outEdge.properties.push_back(graphdyvis::exporter::stringProperty("kind", "distance"));
    document.edges.push_back(std::move(outEdge));
  }

  std::vector<bool> visited(static_cast<std::size_t>(config.cities), false);
  std::unordered_set<std::string> tourEdges;
  int current = 0;
  visited[0] = true;
  int visitedCount = 1;
  int step = 0;
  int tourCost = 0;
  int timestampMs = 700;

  while (visitedCount < config.cities) {
    int bestCity = -1;
    int bestWeight = std::numeric_limits<int>::max();

    for (int candidate = 0; candidate < config.cities; ++candidate) {
      if (visited[static_cast<std::size_t>(candidate)]) {
        continue;
      }
      const std::string edgeId = makeEdgeId(current, candidate);
      const auto edgeIt = edgeIndexById.find(edgeId);
      if (edgeIt == edgeIndexById.end()) {
        continue;
      }
      const int weight = edges[static_cast<std::size_t>(edgeIt->second)].weight;
      if (weight < bestWeight) {
        bestWeight = weight;
        bestCity = candidate;
      }
    }

    if (bestCity < 0) {
      break;
    }

    const std::string chosenEdgeId = makeEdgeId(current, bestCity);
    tourEdges.insert(chosenEdgeId);
    tourCost += bestWeight;

    graphdyvis::exporter::Event event;
    event.eventType = "edge_update";
    event.id = chosenEdgeId;
    event.includeTimestamp = true;
    event.timestampMs = timestampMs;
    event.reason = "Nearest-neighbor heuristic chose the closest unvisited city.";
    event.newProperties.push_back(graphdyvis::exporter::stringProperty("status", "tour"));
    event.newProperties.push_back(graphdyvis::exporter::intProperty("step", step));
    event.newProperties.push_back(graphdyvis::exporter::intProperty("tourCost", tourCost));
    document.events.push_back(std::move(event));

    visited[static_cast<std::size_t>(bestCity)] = true;
    visitedCount += 1;
    current = bestCity;
    step += 1;
    timestampMs += 210;
  }

  const std::string returnEdgeId = makeEdgeId(current, 0);
  const auto returnIt = edgeIndexById.find(returnEdgeId);
  if (returnIt != edgeIndexById.end()) {
    tourEdges.insert(returnEdgeId);
    tourCost += edges[static_cast<std::size_t>(returnIt->second)].weight;

    graphdyvis::exporter::Event closeTour;
    closeTour.eventType = "edge_update";
    closeTour.id = returnEdgeId;
    closeTour.includeTimestamp = true;
    closeTour.timestampMs = timestampMs;
    closeTour.reason = "Closed the tour by returning to the start city.";
    closeTour.newProperties.push_back(graphdyvis::exporter::stringProperty("status", "tour"));
    closeTour.newProperties.push_back(graphdyvis::exporter::intProperty("step", step));
    closeTour.newProperties.push_back(graphdyvis::exporter::intProperty("tourCost", tourCost));
    document.events.push_back(std::move(closeTour));
    timestampMs += 210;
  }

  for (const auto& edge : edges) {
    if (tourEdges.find(edge.id) != tourEdges.end()) {
      continue;
    }

    graphdyvis::exporter::Event remove;
    remove.eventType = "edge_delete";
    remove.id = edge.id;
    remove.includeTimestamp = true;
    remove.timestampMs = timestampMs;
    remove.reason = "Hidden to emphasize the heuristic tour edges.";
    document.events.push_back(std::move(remove));
    timestampMs += 95;
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
    std::cerr << "Failed to write TSP nearest-neighbor demo JSON.\n";
    return 1;
  }

  return 0;
}
