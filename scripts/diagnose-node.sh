#!/usr/bin/env bash
# Read-only snapshot of the Debian k3s node for the Railbound networking setup.
# Run it ON the Debian server and paste the output. It changes nothing and prints no secrets.
# Usage: bash diagnose-node.sh 2>&1 | tee node-report.txt

set -euo pipefail

section() { 
    printf '\n==================== %s\n' "$1" 
}

run_cmd() {
    local desc="$1"
    shift
    section "$desc"
    "$@" 2>&1
}

# Host Information
run_cmd "host" bash -c 'hostname; uname -r; head -n 2 /etc/os-release'

# Networking
run_cmd "addresses" ip -br addr
run_cmd "routes" ip route

# WireGuard
run_cmd "wireguard (needs sudo)" sudo wg show
run_cmd "wireguard service" bash -c 'systemctl is-enabled wg-quick@wg0; systemctl is-active wg-quick@wg0'
run_cmd "wg0.conf (keys removed)" sudo sed -E 's/^(PrivateKey|PresharedKey).*/\1 = (hidden)/' /etc/wireguard/wg0.conf

# Kubernetes Nodes
run_cmd "k3s node" bash -c '
    kubectl get nodes -o wide
    kubectl get nodes -o jsonpath="{range .items[*]}{.metadata.name}{\"  addresses: \"}{.status.addresses}{\"\n\"}{end}"
'

# Kubernetes Config
run_cmd "k3s config" sudo head -n 30 /etc/rancher/k3s/config.yaml

# Agones
run_cmd "agones" bash -c '
    kubectl -n agones-system get deploy
    kubectl get fleet,fleetautoscaler,gameserver -A -o wide
    kubectl api-resources --api-group=allocation.agones.dev | head -n 10
'

run_cmd "agones port range" bash -c '
    kubectl -n agones-system get deploy agones-controller -o jsonpath="{.spec.template.spec.containers[0].args}{\"\n\"}"
    kubectl -n agones-system get cm | head -n 10
'

# Host Ports & Listening Services
run_cmd "who already uses hostPorts" bash -c '
    kubectl get pods -A -o jsonpath="{range .items[*]}{.metadata.namespace}{\"/\"}{.metadata.name}{\"  \"}{.spec.containers[*].ports[?(@.hostPort)].hostPort}{\"\n\"}{end}" | awk "NF>1"
'

run_cmd "listening udp 7000-8000 on the node" bash -c '
    sudo ss -ulnp | awk "NR==1 || /:7[0-9][0-9][0-9] /"
'

# Iptables
run_cmd "iptables nat (portmap / hostPort rules)" bash -c '
    sudo iptables -t nat -S | grep -E "CNI-HOSTPORT|dport 7[0-9]{3}" | head -n 20
'

# Argo & Applications
run_cmd "argo applications" kubectl -n argocd get applications
run_cmd "nakama" bash -c '
    kubectl -n apps get pods,svc -o wide
    kubectl -n apps get pod -l <unsafe_url>app.kubernetes.io/name=nakama</unsafe_url> -o jsonpath="{.items[0].spec.containers[*].name}{\"\n\"}"
'
run_cmd "platform" kubectl -n platform get pods,svc

echo
echo "done"
