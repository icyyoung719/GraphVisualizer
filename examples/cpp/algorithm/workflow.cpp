#include "../graphdyvis_export.hpp"

#include <algorithm>
#include <cstddef>
#include <fstream>
#include <iostream>
#include <random>
#include <sstream>
#include <string>
#include <unordered_set>
#include <vector>

namespace {

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

std::string makeServiceId(int domainIndex, int serviceIndex) {
  std::ostringstream stream;
  stream << "D" << domainIndex << "_S" << serviceIndex;
  return stream.str();
}

std::string makeEdgeId(const std::string& source, const std::string& target) {
  return source + "->" + target;
}

DemoData buildDemoData(const DemoConfig& config) {
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

graphdyvis::exporter::Document buildDocument(const DemoConfig& config) {
  const DemoData data = buildDemoData(config);
  graphdyvis::exporter::Document document;

  for (const auto& node : data.nodes) {
    graphdyvis::exporter::Node outNode;
    outNode.id = node.id;
    outNode.label = node.label;
    outNode.x = node.x;
    outNode.y = node.y;
    outNode.properties.push_back(graphdyvis::exporter::stringProperty("role", node.role));
    outNode.properties.push_back(graphdyvis::exporter::intProperty("layer", node.layer));
    outNode.properties.push_back(graphdyvis::exporter::stringProperty("domain", node.domain));
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
    outEdge.properties.push_back(graphdyvis::exporter::stringProperty("channel", edge.channel));
    document.edges.push_back(std::move(outEdge));
  }

  for (const auto& event : data.events) {
    graphdyvis::exporter::Event outEvent;
    outEvent.eventType = event.eventType;
    outEvent.id = event.id;
    outEvent.timestampMs = event.timestampMs;
    outEvent.includeTimestamp = true;
    outEvent.reason = event.reason;

    if (event.eventType == "edge_update") {
      outEvent.newProperties.push_back(graphdyvis::exporter::stringProperty("status", event.status));
      outEvent.newProperties.push_back(graphdyvis::exporter::intProperty("throughput", event.throughput));
    }

    if (event.eventType == "node_create") {
      outEvent.includeNodePayload = true;
      outEvent.nodePayload.id = "D2_Shotfix";
      outEvent.nodePayload.label = "shotfix";
      outEvent.nodePayload.x = 740;
      outEvent.nodePayload.y = 520;
      outEvent.nodePayload.properties.push_back(graphdyvis::exporter::stringProperty("role", "service"));
      outEvent.nodePayload.properties.push_back(graphdyvis::exporter::intProperty("layer", 3));
      outEvent.nodePayload.properties.push_back(graphdyvis::exporter::stringProperty("domain", "domain_2"));
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
  std::cout << "Usage: workflow [--domains=N] [--services=N] [--seed=N] [--output=FILE]\n";
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
  config.domains = readIntArg(argc, argv, "--domains=", config.domains);
  config.servicesPerDomain = readIntArg(argc, argv, "--services=", config.servicesPerDomain);
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
    std::cerr << "Failed to write workflow demo JSON.\n";
    return 1;
  }

  return 0;
}
