#pragma once

#include <algorithm>
#include <cstddef>
#include <iostream>
#include <random>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

namespace graphdyvis::workflow {

struct DemoConfig {
  int domains = 4;
  int servicesPerDomain = 6;
  unsigned seed = 23;
};

struct NodeSpec {
  std::string id;
  std::string label;
  int x = 0;
  int y = 0;
  std::string role;
  int layer = 0;
  std::string domain;
};

struct EdgeSpec {
  std::string id;
  std::string source;
  std::string target;
  int weight = 1;
  std::string channel;
};

struct EventSpec {
  std::string eventType;
  std::string id;
  int timestampMs = 0;
  std::string reason;
  std::string status;
  int throughput = 0;
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

inline std::string makeServiceId(int domainIndex, int serviceIndex) {
  std::ostringstream stream;
  stream << "D" << domainIndex << "_S" << serviceIndex;
  return stream.str();
}

inline std::string makeEdgeId(const std::string& source, const std::string& target) {
  return source + "->" + target;
}

inline DemoData buildDemoData(const DemoConfig& config) {
  const int domains = std::max(3, config.domains);
  const int servicesPerDomain = std::max(4, config.servicesPerDomain);

  DemoData data;
  data.nodes.push_back(NodeSpec{"ingress", "Ingress", 120, 220, "source", 0, "gateway"});

  for (int domain = 0; domain < domains; ++domain) {
    for (int service = 0; service < servicesPerDomain; ++service) {
      const std::string id = makeServiceId(domain, service);
      std::ostringstream label;
      label << "svc_" << domain << "_" << service;
      data.nodes.push_back(NodeSpec{
          id,
          label.str(),
          320 + domain * 200,
          70 + service * 70,
          "service",
          domain + 1,
          "domain_" + std::to_string(domain),
      });
    }
  }

  data.nodes.push_back(NodeSpec{
      "egress",
      "Egress",
      320 + domains * 200,
      220,
      "target",
      domains + 1,
      "gateway",
  });

  std::mt19937 rng(config.seed);
  std::uniform_int_distribution<int> crossWeight(4, 10);
  std::uniform_int_distribution<int> pathWeight(1, 3);

  for (int service = 0; service < servicesPerDomain; ++service) {
    const std::string target = makeServiceId(0, service);
    data.edges.push_back(EdgeSpec{makeEdgeId("ingress", target), "ingress", target, pathWeight(rng), "ingress"});
  }

  for (int domain = 0; domain + 1 < domains; ++domain) {
    for (int sourceService = 0; sourceService < servicesPerDomain; ++sourceService) {
      const std::string source = makeServiceId(domain, sourceService);
      for (int targetService = 0; targetService < servicesPerDomain; ++targetService) {
        const std::string target = makeServiceId(domain + 1, targetService);
        const bool preferredPath = sourceService == 0 && targetService == 0;
        const int weight = preferredPath ? pathWeight(rng) : crossWeight(rng);
        data.edges.push_back(EdgeSpec{
            makeEdgeId(source, target),
            source,
            target,
            weight,
            preferredPath ? "critical" : "normal",
        });
      }
    }
  }

  for (int service = 0; service < servicesPerDomain; ++service) {
    const std::string source = makeServiceId(domains - 1, service);
    const int weight = service == 0 ? pathWeight(rng) : crossWeight(rng);
    data.edges.push_back(EdgeSpec{makeEdgeId(source, "egress"), source, "egress", weight, service == 0 ? "critical" : "normal"});
  }

  std::unordered_set<std::string> bestPathEdges;
  std::vector<std::string> pathNodes;
  pathNodes.push_back("ingress");
  for (int domain = 0; domain < domains; ++domain) {
    pathNodes.push_back(makeServiceId(domain, 0));
  }
  pathNodes.push_back("egress");

  int timestampMs = 600;
  int throughput = 120;
  for (std::size_t index = 0; index + 1 < pathNodes.size(); ++index) {
    const std::string edgeId = makeEdgeId(pathNodes[index], pathNodes[index + 1]);
    bestPathEdges.insert(edgeId);
    data.events.push_back(EventSpec{
        "edge_update",
        edgeId,
        timestampMs,
        "Scheduler marked this lane as critical for stable throughput.",
        "best-path",
        throughput,
    });
    timestampMs += 420;
    throughput += 35;
  }

  for (const auto& edge : data.edges) {
    if (bestPathEdges.find(edge.id) != bestPathEdges.end()) {
      continue;
    }

    data.events.push_back(EventSpec{
        "edge_delete",
        edge.id,
        timestampMs,
        "Route compacted: redundant branch hidden after optimization.",
        "pruned",
        0,
    });
    timestampMs += 260;
  }

  data.events.push_back(EventSpec{
      "node_create",
      "D2_Shotfix",
      timestampMs,
      "Incident workaround service injected for rollback resilience.",
      "dynamic",
      0,
  });

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
  out << "          \"role\": ";
  writeQuoted(out, node.role);
  out << ",\n";
  out << "          \"layer\": " << node.layer << ",\n";
  out << "          \"domain\": ";
  writeQuoted(out, node.domain);
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
  out << "          \"channel\": ";
  writeQuoted(out, edge.channel);
  out << "\n";
  out << "        }\n";
  out << "      }";
}

inline void writeNodeCreateEventJson(std::ostream& out, const EventSpec& event) {
  out << "    {\n";
  out << "      \"eventType\": \"node_create\",\n";
  out << "      \"timestampMs\": " << event.timestampMs << ",\n";
  out << "      \"reason\": ";
  writeQuoted(out, event.reason);
  out << ",\n";
  out << "      \"node\": {\n";
  out << "        \"id\": \"D2_Shotfix\",\n";
  out << "        \"label\": \"shotfix\",\n";
  out << "        \"x\": 740,\n";
  out << "        \"y\": 520,\n";
  out << "        \"properties\": {\n";
  out << "          \"role\": \"service\",\n";
  out << "          \"layer\": 3,\n";
  out << "          \"domain\": \"domain_2\"\n";
  out << "        }\n";
  out << "      }\n";
  out << "    }";
}

inline void writeEdgeEventJson(std::ostream& out, const EventSpec& event) {
  out << "    {\n";
  out << "      \"eventType\": ";
  writeQuoted(out, event.eventType);
  out << ",\n";
  out << "      \"id\": ";
  writeQuoted(out, event.id);
  out << ",\n";
  out << "      \"timestampMs\": " << event.timestampMs << ",\n";
  out << "      \"reason\": ";
  writeQuoted(out, event.reason);

  if (event.eventType == "edge_update") {
    out << ",\n";
    out << "      \"newProperties\": {\n";
    out << "        \"status\": ";
    writeQuoted(out, event.status);
    out << ",\n";
    out << "        \"throughput\": " << event.throughput << "\n";
    out << "      }";
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
    const auto& event = data.events[index];
    if (event.eventType == "node_create") {
      writeNodeCreateEventJson(out, event);
    } else {
      writeEdgeEventJson(out, event);
    }

    out << (index + 1 < data.events.size() ? ",\n" : "\n");
  }
  out << "  ]\n";
  out << "}\n";

  return static_cast<bool>(out);
}

}  // namespace graphdyvis::workflow

