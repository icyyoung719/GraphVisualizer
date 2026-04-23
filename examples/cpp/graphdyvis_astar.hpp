#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <iostream>
#include <limits>
#include <queue>
#include <random>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace graphdyvis::astar {

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

inline std::string escapeJson(std::string_view value) {
  std::string result;
  result.reserve(value.size() + 8);
  for (char ch : value) {
    switch (ch) {
      case '\\':
        result += "\\\\";
        break;
      case '"':
        result += "\\\"";
        break;
      case '\n':
        result += "\\n";
        break;
      case '\r':
        result += "\\r";
        break;
      case '\t':
        result += "\\t";
        break;
      default:
        result += ch;
        break;
    }
  }
  return result;
}

inline void writeQuoted(std::ostream& out, std::string_view value) {
  out << '"' << escapeJson(value) << '"';
}

inline std::string makeNodeId(int layer, int index) {
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

inline std::string makeEdgeId(const std::string& source, const std::string& target) {
  return source + "->" + target;
}

inline int heuristicForLayer(int currentLayer, int targetLayer) {
  return std::max(0, targetLayer - currentLayer) * 2;
}

inline DemoData buildDemoData(const DemoConfig& config) {
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

inline void writeNodeJson(std::ostream& out, const NodeSpec& node) {
  out << "      {\n";
  out << "        \"id\": ";
  writeQuoted(out, node.id);
  out << ",\n";
  out << "        \"label\": ";
  writeQuoted(out, node.label);
  out << ",\n";
  out << "        \"x\": " << node.x << ",\n";
  out << "        \"y\": " << node.y << ",\n";
  out << "        \"properties\": {\n";
  out << "          \"distance\": " << node.distance << ",\n";
  out << "          \"layer\": " << node.layer << ",\n";
  out << "          \"role\": ";
  writeQuoted(out, node.role);
  out << "\n";
  out << "        }\n";
  out << "      }";
}

inline void writeEdgeJson(std::ostream& out, const EdgeSpec& edge) {
  out << "      {\n";
  out << "        \"id\": ";
  writeQuoted(out, edge.id);
  out << ",\n";
  out << "        \"source\": ";
  writeQuoted(out, edge.source);
  out << ",\n";
  out << "        \"target\": ";
  writeQuoted(out, edge.target);
  out << ",\n";
  out << "        \"label\": ";
  writeQuoted(out, std::to_string(edge.weight));
  out << ",\n";
  out << "        \"weight\": " << edge.weight << ",\n";
  out << "        \"properties\": {\n";
  out << "          \"relaxed\": " << (edge.relaxed ? "true" : "false") << ",\n";
  out << "          \"bestPath\": " << (edge.bestPath ? "true" : "false") << ",\n";
  out << "          \"step\": " << edge.step << "\n";
  out << "        }\n";
  out << "      }";
}

inline void writeEventJson(std::ostream& out, const EventSpec& event) {
  out << "    {\n";
  out << "      \"eventType\": ";
  writeQuoted(out, event.type);
  out << ",\n";
  out << "      \"id\": ";
  writeQuoted(out, event.id);
  out << ",\n";
  out << "      \"timestampMs\": " << event.timestampMs << ",\n";
  out << "      \"reason\": ";
  writeQuoted(out, event.reason);
  if (event.type == "edge_update") {
    out << ",\n";
    out << "      \"newProperties\": {\n";
    out << "        \"status\": ";
    writeQuoted(out, event.status);
    out << ",\n";
    out << "        \"relaxed\": " << (event.relaxed ? "true" : "false") << ",\n";
    out << "        \"bestPath\": " << (event.bestPath ? "true" : "false") << ",\n";
    out << "        \"cumulativeCost\": " << event.cumulativeCost << "\n";
    out << "      }";
    if (event.hasNewWeight) {
      out << ",\n      \"newWeight\": " << event.newWeight;
    }
  }
  out << "\n    }";
}

inline bool writeDemoGraphJson(const DemoConfig& config, std::ostream& out) {
  const DemoData data = buildDemoData(config);

  out << "{\n";
  out << "  \"schemaVersion\": \"1.0\",\n";
  out << "  \"graph\": {\n";
  out << "    \"nodes\": [\n";
  for (std::size_t index = 0; index < data.nodes.size(); ++index) {
    writeNodeJson(out, data.nodes[index]);
    out << (index + 1 < data.nodes.size() ? ",\n" : "\n");
  }
  out << "    ],\n";
  out << "    \"edges\": [\n";
  for (std::size_t index = 0; index < data.edges.size(); ++index) {
    writeEdgeJson(out, data.edges[index]);
    out << (index + 1 < data.edges.size() ? ",\n" : "\n");
  }
  out << "    ]\n";
  out << "  },\n";
  out << "  \"events\": [\n";
  for (std::size_t index = 0; index < data.events.size(); ++index) {
    writeEventJson(out, data.events[index]);
    out << (index + 1 < data.events.size() ? ",\n" : "\n");
  }
  out << "  ]\n";
  out << "}\n";

  return static_cast<bool>(out);
}

}  // namespace graphdyvis::astar
