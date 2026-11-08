#!/usr/bin/env bash
# Read-only snapshot of the Debian k3s node for the Railbound networking setup.
# Run it ON the Debian server and paste the output. It changes nothing and prints no secrets.
#   bash diagnose-node.sh 2>&1 | tee node-report.txt
set -u
section() { printf '\n==================== %s\n' "$1"; }

section "host"
hostname; uname -r; cat /etc/os-release | head -2
section "addresses"
ip -br addr
section "routes"
ip route
section "wireguard (needs sudo)"
sudo wg show 2>&1 | sed -E 's/(private key: ).*/\1(hidden)/; s/(preshared key: ).*/\1(hidden)/'
section "wireguard service"
systemctl is-enabled wg-quick@wg0 2>&1; systemctl is-active wg-quick@wg0 2>&1
section "wg0.conf (keys removed)"
sudo sed -E 's/^(PrivateKey|PresharedKey).*/\1 = (hidden)/' /etc/wireguard/wg0.conf 2>&1
section "k3s node"
kubectl get nodes -o wide
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"  addresses: "}{.status.addresses}{"\n"}{end}'
section "k3s config"
sudo cat /etc/rancher/k3s/config.yaml 2>&1 | head -30
section "agones"
kubectl -n agones-system get deploy
kubectl get fleet,fleetautoscaler,gameserver -A -o wide 2>&1
kubectl api-resources --api-group=allocation.agones.dev 2>&1 | head
section "agones port range"
kubectl -n agones-system get deploy agones-controller -o jsonpath='{.spec.template.spec.containers[0].args}{"\n"}' 2>&1
kubectl -n agones-system get cm 2>&1 | head
section "who already uses hostPorts"
kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"  "}{.spec.containers[*].ports[?(@.hostPort)].hostPort}{"\n"}{end}' 2>&1 | awk 'NF>1'
section "listening udp 7000-8000 on the node"
sudo ss -ulnp 2>&1 | awk 'NR==1 || /:7[0-9][0-9][0-9] /'
section "iptables nat (portmap / hostPort rules)"
sudo iptables -t nat -S 2>&1 | grep -E 'CNI-HOSTPORT|dport 7[0-9]{3}' | head -20
section "argo applications"
kubectl -n argocd get applications 2>&1
section "nakama"
kubectl -n apps get pods,svc -o wide 2>&1
kubectl -n apps get pod -l app.kubernetes.io/name=nakama -o jsonpath='{.items[0].spec.containers[*].name}{"\n"}' 2>&1
section "platform"
kubectl -n platform get pods,svc 2>&1
echo; echo "done"
