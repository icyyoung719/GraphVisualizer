#include "graphdyvis_export.hpp"

#include <algorithm>
#include <cstddef>
#include <fstream>
#include <iostream>
#include <random>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

struct DemoConfig {
  int layers = 5;
  int width = 3;
  unsigned seed = 7;
};

struct NodeSpec {
  std::string id;
  std::string label;
  int x = 0;
  int y = 0;
  int distance = 0;
  int layer = 0;
  std::string role;
};

struct EdgeSpec {
  std::string id;
  std::string source;
  std::string target;
  int weight = 0;
  bool relaxed = false;
  bool bestPath = false;
  int step = 0;
};

struct EventSpec {
  std::string type;
  std::string id;
  std::string reason;
  int timestampMs = 0;
  int newWeight = 0;
  bool hasNewWeight = false;
  std::string status;
  bool relaxed = false;
  bool bestPath = false;
  int cumulativeCost = 0;
};

struct DemoData {
  std::vector<NodeSpec> nodes;
  std::vector<EdgeSpec> edges;
  std::vector<EventSpec> events;
};

std::string makeNodeId(int layer, int index) {
  if (layer == 0) {
    return "S";
  }
  if (layer == -1) {
    return "T";
  }
  std::ostringstream stream;
  stream << 'L' << layer << '_' << index;
  return stream.str();
}

std::string makeEdgeId(const std::string& source, const std::string& target) {
  return source + "->" + target;
}

DemoData buildDemoData(const DemoConfig& config) {
  const int layerCount = std::max(3, config.layers);
  const int width = std::max(1, config.width);
  const int sourceLayer = 0;
  const int targetLayer = layerCount - 1;

  DemoData data;
  data.nodes.push_back(NodeSpec{"S", "S", 120, 160, 0, sourceLayer, "source"});

  for (int layer = 1; layer < targetLayer; ++layer) {
    for (int index = 0; index < width; ++index) {
      const std::string id = makeNodeId(layer, index);
      data.nodes.push_back(NodeSpec{
          id,
          id,
          120 + layer * 160,
          70 + index * 110,
          layer * 2,
          layer,
          "waypoint",
      });
    }
  }

  data.nodes.push_back(NodeSpec{"T", "T", 120 + targetLayer * 160, 160, targetLayer * 2, targetLayer, "target"});

  std::mt19937 rng(config.seed);
  std::uniform_int_distribution<int> lightWeight(1, 2);
  std::uniform_int_distribution<int> heavyWeight(4, 7);

  std::vector<std::vector<std::string>> layers;
  layers.push_back({"S"});
  for (int layer = 1; layer < targetLayer; ++layer) {
    std::vector<std::string> layerNodes;
    for (int index = 0; index < width; ++index) {
      layerNodes.push_back(makeNodeId(layer, index));
    }
    layers.push_back(layerNodes);
  }
  layers.push_back({"T"});

  for (std::size_t layerIndex = 0; layerIndex + 1 < layers.size(); ++layerIndex) {
    for (std::size_t sourceIndex = 0; sourceIndex < layers[layerIndex].size(); ++sourceIndex) {
      const std::string& sourceId = layers[layerIndex][sourceIndex];
      const bool isPathCandidate = sourceIndex == 0;
      for (std::size_t targetIndex = 0; targetIndex < layers[layerIndex + 1].size(); ++targetIndex) {
        const std::string& targetId = layers[layerIndex + 1][targetIndex];
        const int weight = isPathCandidate && targetIndex == 0 ? lightWeight(rng) : heavyWeight(rng);
        data.edges.push_back(EdgeSpec{
            makeEdgeId(sourceId, targetId),
            sourceId,
            targetId,
            weight,
            false,
            false,
            0,
        });
      }
    }
  }

  std::unordered_map<std::string, const EdgeSpec*> edgeByKey;
  for (const auto& edge : data.edges) {
    edgeByKey.emplace(edge.id, &edge);
  }

  std::vector<std::string> pathNodes;
  std::vector<std::string> pathEdges;
  pathNodes.push_back("S");
  for (int layer = 1; layer < targetLayer; ++layer) {
    pathNodes.push_back(makeNodeId(layer, 0));
  }
  pathNodes.push_back("T");

  int cumulativeCost = 0;
  int timestampMs = 500;
  for (std::size_t index = 0; index + 1 < pathNodes.size(); ++index) {
    const std::string& sourceId = pathNodes[index];
    const std::string& targetId = pathNodes[index + 1];
    const std::string edgeId = makeEdgeId(sourceId, targetId);
    const auto edgeIterator = edgeByKey.find(edgeId);
    if (edgeIterator == edgeByKey.end()) {
      continue;
    }

    cumulativeCost += edgeIterator->second->weight;
    pathEdges.push_back(edgeId);
    data.events.push_back(EventSpec{
        "edge_update",
        edgeId,
        "A* confirmed this edge on the best path.",
        timestampMs,
        0,
        false,
        "best-path",
        true,
        true,
        cumulativeCost,
    });
    timestampMs += 500;
  }

  for (const auto& edge : data.edges) {
    if (std::find(pathEdges.begin(), pathEdges.end(), edge.id) != pathEdges.end()) {
      continue;
    }

    data.events.push_back(EventSpec{
        "edge_delete",
        edge.id,
        "A* pruned this branch after finding a cheaper route.",
        timestampMs,
        0,
        false,
        "pruned",
        false,
        false,
        0,
    });
    timestampMs += 350;
  }

  return data;
}

graphdyvis::exporter::Document buildDocument(const DemoConfig& config) {
  const DemoData data = buildDemoData(config);
  graphdyvis::exporter::Document document;

  for (const auto& node : data.nodes) {
    graphdyvis::exporter::Node outNode;
    outNode.id = node.id;
    outNode.label = node.label;
    outNode.x = node.x;
    outNode.y = node.y;
    outNode.properties.push_back(graphdyvis::exporter::intProperty("distance", node.distance));
    outNode.properties.push_back(graphdyvis::exporter::intProperty("layer", node.layer));
    outNode.properties.push_back(graphdyvis::exporter::stringProperty("role", node.role));
    document.nodes.push_back(std::move(outNode));
  }

  for (const auto& edge : data.edges) {
    graphdyvis::exporter::Edge outEdge;
    outEdge.id = edge.id;
    outEdge.source = edge.source;
    outEdge.target = edge.target;
    outEdge.label = std::to_string(edge.weight);
    outEdge.weight = edge.weight;
    outEdge.includeWeight = true;
    outEdge.properties.push_back(graphdyvis::exporter::boolProperty("relaxed", edge.relaxed));
    outEdge.properties.push_back(graphdyvis::exporter::boolProperty("bestPath", edge.bestPath));
    outEdge.properties.push_back(graphdyvis::exporter::intProperty("step", edge.step));
    document.edges.push_back(std::move(outEdge));
  }

  for (const auto& event : data.events) {
    graphdyvis::exporter::Event outEvent;
    outEvent.eventType = event.type;
    outEvent.id = event.id;
    outEvent.reason = event.reason;
    outEvent.timestampMs = event.timestampMs;
    outEvent.includeTimestamp = true;
    if (event.type == "edge_update") {
      outEvent.newProperties.push_back(graphdyvis::exporter::stringProperty("status", event.status));
      outEvent.newProperties.push_back(graphdyvis::exporter::boolProperty("relaxed", event.relaxed));
      outEvent.newProperties.push_back(graphdyvis::exporter::boolProperty("bestPath", event.bestPath));
      outEvent.newProperties.push_back(graphdyvis::exporter::intProperty("cumulativeCost", event.cumulativeCost));
      if (event.hasNewWeight) {
        outEvent.includeNewWeight = true;
        outEvent.newWeight = event.newWeight;
      }
    }
    document.events.push_back(std::move(outEvent));
  }

  return document;
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
  std::cout << "Usage: astar_demo [--layers=N] [--width=N] [--seed=N] [--output=FILE]\n";
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
  config.layers = readIntArg(argc, argv, "--layers=", config.layers);
  config.width = readIntArg(argc, argv, "--width=", config.width);
  config.seed = readUnsignedArg(argc, argv, "--seed=", config.seed);
  const std::string outputPath = readStringArg(argc, argv, "--output=", std::string());

  const graphdyvis::exporter::Document document = buildDocument(config);

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
    std::cerr << "Failed to write A* demo JSON.\n";
    return 1;
  }

  return 0;
}
