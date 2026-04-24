#pragma once

#include <ostream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace graphdyvis::exporter {

struct Property {
  std::string key;
  std::string rawJsonValue;
};

struct Node {
  std::string id;
  std::string label;
  int x = 0;
  int y = 0;
  std::vector<Property> properties;
};

struct Edge {
  std::string id;
  std::string source;
  std::string target;
  std::string label;
  int weight = 0;
  bool includeWeight = false;
  std::vector<Property> properties;
};

struct Event {
  std::string eventType;
  std::string id;
  int timestampMs = 0;
  bool includeTimestamp = false;
  std::string reason;
  std::vector<Property> newProperties;
  bool includeNewWeight = false;
  int newWeight = 0;
  bool includeNodePayload = false;
  Node nodePayload;
  bool includeEdgePayload = false;
  Edge edgePayload;
};

struct Document {
  std::string schemaVersion = "1.0";
  std::vector<Node> nodes;
  std::vector<Edge> edges;
  std::vector<Event> events;
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

inline Property stringProperty(std::string key, std::string value) {
  return Property{std::move(key), "\"" + escapeJson(value) + "\""};
}

inline Property intProperty(std::string key, int value) {
  return Property{std::move(key), std::to_string(value)};
}

inline Property boolProperty(std::string key, bool value) {
  return Property{std::move(key), value ? "true" : "false"};
}

inline void writeQuoted(std::ostream& out, std::string_view value) {
  out << '"' << escapeJson(value) << '"';
}

inline void writeRawProperty(std::ostream& out, const Property& property) {
  writeQuoted(out, property.key);
  out << ": " << property.rawJsonValue;
}

inline void writePropertiesObject(std::ostream& out, const std::vector<Property>& properties, int indent) {
  const std::string pad(static_cast<std::size_t>(indent), ' ');
  const std::string padInner(static_cast<std::size_t>(indent + 2), ' ');
  out << "{\n";
  for (std::size_t index = 0; index < properties.size(); ++index) {
    out << padInner;
    writeRawProperty(out, properties[index]);
    out << (index + 1 < properties.size() ? ",\n" : "\n");
  }
  out << pad << "}";
}

inline void writeNodeJson(std::ostream& out, const Node& node, int indent) {
  const std::string pad(static_cast<std::size_t>(indent), ' ');
  const std::string padInner(static_cast<std::size_t>(indent + 2), ' ');
  out << pad << "{\n";
  out << padInner << "\"id\": ";
  writeQuoted(out, node.id);
  out << ",\n";
  out << padInner << "\"label\": ";
  writeQuoted(out, node.label);
  out << ",\n";
  out << padInner << "\"x\": " << node.x << ",\n";
  out << padInner << "\"y\": " << node.y << ",\n";
  out << padInner << "\"properties\": ";
  writePropertiesObject(out, node.properties, indent + 2);
  out << "\n";
  out << pad << "}";
}

inline void writeEdgeJson(std::ostream& out, const Edge& edge, int indent) {
  const std::string pad(static_cast<std::size_t>(indent), ' ');
  const std::string padInner(static_cast<std::size_t>(indent + 2), ' ');
  out << pad << "{\n";
  out << padInner << "\"id\": ";
  writeQuoted(out, edge.id);
  out << ",\n";
  out << padInner << "\"source\": ";
  writeQuoted(out, edge.source);
  out << ",\n";
  out << padInner << "\"target\": ";
  writeQuoted(out, edge.target);
  out << ",\n";
  out << padInner << "\"label\": ";
  writeQuoted(out, edge.label);
  if (edge.includeWeight) {
    out << ",\n";
    out << padInner << "\"weight\": " << edge.weight;
  }
  out << ",\n";
  out << padInner << "\"properties\": ";
  writePropertiesObject(out, edge.properties, indent + 2);
  out << "\n";
  out << pad << "}";
}

inline void writeEventJson(std::ostream& out, const Event& event, int indent) {
  const std::string pad(static_cast<std::size_t>(indent), ' ');
  const std::string padInner(static_cast<std::size_t>(indent + 2), ' ');
  out << pad << "{\n";
  out << padInner << "\"eventType\": ";
  writeQuoted(out, event.eventType);

  if (!event.id.empty()) {
    out << ",\n";
    out << padInner << "\"id\": ";
    writeQuoted(out, event.id);
  }

  if (event.includeTimestamp) {
    out << ",\n";
    out << padInner << "\"timestampMs\": " << event.timestampMs;
  }

  if (!event.reason.empty()) {
    out << ",\n";
    out << padInner << "\"reason\": ";
    writeQuoted(out, event.reason);
  }

  if (!event.newProperties.empty()) {
    out << ",\n";
    out << padInner << "\"newProperties\": ";
    writePropertiesObject(out, event.newProperties, indent + 2);
  }

  if (event.includeNewWeight) {
    out << ",\n";
    out << padInner << "\"newWeight\": " << event.newWeight;
  }

  if (event.includeNodePayload) {
    out << ",\n";
    out << padInner << "\"node\": ";
    writeNodeJson(out, event.nodePayload, indent + 2);
  }

  if (event.includeEdgePayload) {
    out << ",\n";
    out << padInner << "\"edge\": ";
    writeEdgeJson(out, event.edgePayload, indent + 2);
  }

  out << "\n";
  out << pad << "}";
}

inline bool writeGraphJson(const Document& document, std::ostream& out) {
  out << "{\n";
  out << "  \"schemaVersion\": ";
  writeQuoted(out, document.schemaVersion);
  out << ",\n";
  out << "  \"graph\": {\n";
  out << "    \"nodes\": [\n";
  for (std::size_t index = 0; index < document.nodes.size(); ++index) {
    writeNodeJson(out, document.nodes[index], 6);
    out << (index + 1 < document.nodes.size() ? ",\n" : "\n");
  }
  out << "    ],\n";
  out << "    \"edges\": [\n";
  for (std::size_t index = 0; index < document.edges.size(); ++index) {
    writeEdgeJson(out, document.edges[index], 6);
    out << (index + 1 < document.edges.size() ? ",\n" : "\n");
  }
  out << "    ]\n";
  out << "  },\n";
  out << "  \"events\": [\n";
  for (std::size_t index = 0; index < document.events.size(); ++index) {
    writeEventJson(out, document.events[index], 4);
    out << (index + 1 < document.events.size() ? ",\n" : "\n");
  }
  out << "  ]\n";
  out << "}\n";

  return static_cast<bool>(out);
}

}  // namespace graphdyvis::exporter
