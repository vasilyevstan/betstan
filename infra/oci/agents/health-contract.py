#!/usr/bin/env python3
import json
import sys


EXPECTED_DEPLOYMENTS = {
    "gaming-auth-depl",
    "gaming-bet-depl",
    "gaming-backoffice-depl",
    "gaming-client-depl",
    "gaming-event-depl",
    "gaming-gamemaster-depl",
    "gaming-moderation-depl",
    "gaming-resulting-depl",
    "gaming-slip-depl",
    "gaming-rabbitmq-depl",
}
EXPECTED_SERVICES = {
    "gaming-auth-srv",
    "gaming-bet-srv",
    "gaming-backoffice-srv",
    "gaming-client-srv",
    "gaming-event-srv",
    "gaming-gamemaster-srv",
    "gaming-moderation-srv",
    "gaming-resulting-srv",
    "gaming-slip-srv",
    "gaming-rabbitmq-srv",
    "gaming-auth-mongo-srv",
    "gaming-shared-mongo-srv",
}
EXPECTED_DATABASES = {
    "gaming_auth",
    "gaming_bet",
    "gaming_backoffice",
    "gaming_event",
    "gaming_gamemaster",
    "gaming_moderation",
    "gaming_resulting",
    "gaming_slip",
}
EXPECTED_MONGO_PVC_INVENTORY = [
    {
        "name": "gaming-auth-mongo-data",
        "phase": "Bound",
    }
]
EXPECTED_PLATFORM_DIGESTS = {
    "ingress-nginx/ingress-nginx-controller": "sha256:594ceea76b01c592858f803f9ff4d2cb40542cae2060410b2c95f75907d659e1",
    "cert-manager/cert-manager": "sha256:416a2d76870d996460e62bd7f521bf14fa017be9e3e904aab92163a331fcb61a",
    "cert-manager/cert-manager-webhook": "sha256:d8b3961b51c8c7320633f8208dc46bf88aa13804d0f7cbe48a096b2c523cee42",
    "cert-manager/cert-manager-cainjector": "sha256:ccf6b919ec0500745a47a910118f834f9636d0aac1ff221245cd2557ed8c7c98",
}
EXPECTED_RABBITMQ_QUEUE_COUNT = 22


class ContractFailure(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise ContractFailure(code, message)


def validate(snapshot):
    context = snapshot.get("context", {})
    runtime_mode = context.get("runtime_mode", "oke")
    require(runtime_mode in {"oke", "k3s"}, "runtime-mode", "runtime mode is not approved")
    require(
        context.get("kube_provenance") is True,
        "wrong-context",
        "kubeconfig does not contain exact runtime provenance",
    )
    require(
        context.get("cluster_fingerprint") == context.get("expected_cluster_fingerprint"),
        "wrong-cluster",
        "runtime fingerprint differs from infrastructure provenance",
    )
    require(
        context.get("compartment_fingerprint") == context.get("expected_compartment_fingerprint"),
        "wrong-compartment",
        "runtime compartment differs from infrastructure provenance",
    )
    require(
        context.get("namespace") == context.get("expected_namespace"),
        "wrong-namespace",
        "Kubernetes namespace differs from approved provenance",
    )

    node = snapshot.get("node", {})
    require(node.get("count") == 1, "wrong-node-count", "expected exactly one Kubernetes worker")
    require(node.get("ready") is True, "node-not-ready", "Kubernetes worker is not Ready")
    require(node.get("architecture") == "arm64", "wrong-architecture", "Kubernetes worker is not ARM64")
    require(
        node.get("instance_type") == "VM.Standard.A1.Flex",
        "wrong-node-shape",
        "Kubernetes worker is not VM.Standard.A1.Flex",
    )
    for condition in ("memory_pressure", "disk_pressure", "pid_pressure", "network_unavailable"):
        require(node.get(condition) is False, "node-pressure", f"node condition is unsafe: {condition}")
    require(
        float(node.get("memory_percent", 101)) <= float(snapshot.get("thresholds", {}).get("memory_percent", 70)),
        "memory-threshold",
        "node memory exceeds the approved fit threshold",
    )
    require(
        float(node.get("cpu_percent", 101)) <= float(snapshot.get("thresholds", {}).get("cpu_percent", 90)),
        "cpu-threshold",
        "node CPU exceeds the approved fit threshold",
    )
    require(
        float(node.get("disk_percent", 101)) <= float(snapshot.get("thresholds", {}).get("disk_percent", 70)),
        "disk-threshold",
        "node filesystem exceeds the approved fit threshold",
    )

    workloads = snapshot.get("workloads", [])
    deployment_names = {item.get("name") for item in workloads if item.get("kind") == "Deployment"}
    require(
        deployment_names == EXPECTED_DEPLOYMENTS,
        "workload-set",
        "expected deployment set is missing or contains an unexpected workload",
    )
    statefulsets = [item for item in workloads if item.get("kind") == "StatefulSet"]
    require(
        len(statefulsets) == 1 and statefulsets[0].get("name") == "gaming-auth-mongo-depl",
        "extra-mongo",
        "expected exactly the active auth Mongo StatefulSet",
    )
    for workload in workloads:
        require(
            int(workload.get("desired", 0)) > 0
            and int(workload.get("ready", 0)) == int(workload.get("desired", 0)),
            "workload-not-ready",
            f"workload is not fully available: {workload.get('name', 'unknown')}",
        )

    platform_workloads = snapshot.get("platform_workloads", [])
    require(
        {item.get("identity") for item in platform_workloads} == set(EXPECTED_PLATFORM_DIGESTS),
        "platform-workload-set",
        "ingress-nginx or cert-manager deployment set is incomplete",
    )
    for workload in platform_workloads:
        identity = workload.get("identity")
        require(
            int(workload.get("desired", 0)) > 0
            and int(workload.get("ready", 0)) == int(workload.get("desired", 0)),
            "platform-workload-not-ready",
            f"platform workload is not available: {identity}",
        )
        require(workload.get("architecture") == "arm64", "platform-architecture", "platform workload is not ARM64")
        require(
            workload.get("image", "").endswith("@" + EXPECTED_PLATFORM_DIGESTS[identity]),
            "platform-digest",
            f"platform image digest differs from reviewed release: {identity}",
        )

    pods = snapshot.get("pods", [])
    require(bool(pods), "pods-missing", "no application pods were observed")
    for pod in pods:
        require(pod.get("ready") is True, "pod-not-ready", f"pod is not Ready: {pod.get('name', 'unknown')}")
        require(pod.get("architecture") == "arm64", "pod-architecture", "pod is not scheduled on ARM64")
        require(pod.get("digest_match") is True, "digest-mismatch", "pod image digest differs from provenance")
        require(int(pod.get("restarts", 0)) == 0, "restart-increase", "unexpected pod restart increase")
        reason = str(pod.get("last_reason", "")).lower()
        require(
            not any(value in reason for value in ("oomkilled", "evicted", "crashloopbackoff")),
            "pod-failure-reason",
            "pod reports OOM, eviction, or crash loop",
        )

    mongo = snapshot.get("mongo", {})
    require(mongo.get("statefulset_count") == 1, "extra-mongo", "expected exactly one Mongo StatefulSet")
    require(
        mongo.get("pvc_inventory") == EXPECTED_MONGO_PVC_INVENTORY,
        "mongo-pvc-topology",
        "Mongo PVC inventory differs from the exact Bound shared claim",
    )
    require(mongo.get("pvc_count") == 1, "mongo-pvc-count", "expected exactly one Mongo PVC")
    require(mongo.get("pvc_bound") is True, "mongo-pvc-unbound", "Mongo PVC is not Bound")
    require(mongo.get("pvc_gib") == 50, "mongo-pvc-size", "Mongo PVC was not created at 50 GiB")
    require(
        mongo.get("version") == "8.2.12" and mongo.get("major_minor") == "8.2",
        "mongo-version",
        "Mongo runtime is not the reviewed 8.2.12 release",
    )
    require(mongo.get("fcv") == "8.2", "mongo-fcv", "Mongo FCV is not 8.2")
    require(
        set(mongo.get("logical_databases", [])) == EXPECTED_DATABASES,
        "mongo-databases",
        "Mongo does not contain exactly the eight logical database names",
    )

    services = snapshot.get("services", [])
    service_names = {item.get("name") for item in services}
    require(service_names == EXPECTED_SERVICES, "service-set", "expected service set is incomplete or unexpected")
    for service in services:
        require(
            service.get("ready_endpoints") is True,
            "empty-endpoint",
            f"service has no ready endpoint: {service.get('name', 'unknown')}",
        )
        require(service.get("type") == "ClusterIP", "public-data-service", "application/data service is public")

    rabbit = snapshot.get("rabbitmq", {})
    require(
        rabbit.get("queue_count") == EXPECTED_RABBITMQ_QUEUE_COUNT,
        "queue-count",
        f"RabbitMQ does not expose the expected {EXPECTED_RABBITMQ_QUEUE_COUNT} queues",
    )
    require(rabbit.get("baseline_match") is True, "queue-baseline", "RabbitMQ queue set differs from baseline")
    require(rabbit.get("all_consumers") is True, "queue-consumers", "RabbitMQ queue consumer is missing")
    require(int(rabbit.get("backlog", -1)) == 0, "queue-backlog", "RabbitMQ has unexpected backlog")

    ingress = snapshot.get("ingress", {})
    expected_lb_services = 1 if runtime_mode == "oke" else 0
    require(
        ingress.get("load_balancer_service_count") == expected_lb_services,
        "load-balancer-count",
        "Kubernetes LoadBalancer service count differs from the runtime contract",
    )
    require(ingress.get("ipv4_match") is True, "ingress-ip", "ingress IPv4 differs from OCI provenance")
    require(ingress.get("certificate_ready") is True, "certificate", "TLS certificate is not Ready")
    require(
        ingress.get("canonical_certificate_ready") is True,
        "canonical-certificate",
        "canonical apex/www certificate or SAN set is not Ready",
    )
    require(
        ingress.get("diagnostic_certificate_ready") is True,
        "diagnostic-certificate",
        "diagnostic nip.io certificate is not Ready",
    )
    require(
        ingress.get("cluster_issuer_ready") is True,
        "cluster-issuer",
        "production Let's Encrypt ClusterIssuer is not Ready",
    )
    require(ingress.get("https_trusted") is True, "https-trust", "HTTPS endpoint is not trusted")
    require(ingress.get("http_redirect") is True, "http-redirect", "HTTP does not redirect safely to HTTPS")
    require(ingress.get("www_redirect") is True, "www-redirect", "www does not redirect safely to the apex")
    require(
        ingress.get("diagnostic_https_trusted") is True,
        "diagnostic-https",
        "diagnostic HTTPS endpoint is not trusted",
    )
    require(ingress.get("dns_match") is True, "canonical-dns", "canonical DNS differs from OCI provenance")

    application = snapshot.get("application", {})
    require(application.get("homepage_marker") is True, "homepage", "homepage marker is missing")
    require(application.get("api_json") is True, "api-json", "API route returned invalid JSON or HTML")
    require(application.get("e2e") is True, "e2e", "Playwright OCI user journey failed")

    images = snapshot.get("images", {})
    require(images.get("all_immutable") is True, "mutable-image", "workload uses a mutable image reference")
    require(images.get("all_digest_match") is True, "digest-mismatch", "running image digest differs from provenance")

    inventory = snapshot.get("inventory", {})
    require(inventory.get("expected_monthly_cost") == 0, "cost", "inventory does not project zero cost")
    require(inventory.get("unexpected_billable") is False, "billable-resource", "unexpected billable resource detected")
    require(inventory.get("lb_type") == "lb", "lb-type", "OCI service is not the approved load balancer type")
    require(inventory.get("lb_shape") == "flexible", "lb-shape", "OCI load balancer is not flexible")
    require(
        inventory.get("lb_min_mbps") == 10 and inventory.get("lb_max_mbps") == 10,
        "lb-bandwidth",
        "OCI load balancer is not fixed at 10/10 Mbps",
    )


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: health-contract.py SNAPSHOT.json")
    try:
        with open(sys.argv[1], encoding="utf-8") as handle:
            snapshot = json.load(handle)
        validate(snapshot)
    except ContractFailure as error:
        print(f"NO_GO code={error.code} reason={error}", file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f"NO_GO code=invalid-snapshot reason={error}", file=sys.stderr)
        return 1
    print("DEPLOYED_HEALTHY")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
