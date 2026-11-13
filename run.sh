    sudo kubectl create secret generic cloudflare-tunnel-token \
      --namespace apps \
      --from-literal=token="<YOUR_CLOUDFLARE_TUNNEL_TOKEN>"


    sudo kubectl create secret docker-registry registry-pull \
      --namespace platform \
      --docker-server=registry.kushanherath.me \
      --docker-username=registryadmin \
      --docker-password=12345678



    apiVersion: argoproj.io/v1alpha1
    kind: Application
    metadata:
      name: root-apps
      namespace: argocd
      finalizers:
        - resources-finalizer.argocd.argoproj.io
    spec:
      project: default
      source:
        repoURL: https://github.com/OneEngine-studio/railbound-gitops.git
        targetRevision: main
        path: app
      destination:
        server: https://kubernetes.default.svc
        namespace: argocd
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true



curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

    helm repo add agones https://agones.dev/chart/stable
    helm repo update

    helm upgrade --install agones agones/agones \
      --namespace agones-system \
      --create-namespace \
      --kubeconfig /etc/rancher/k3s/k3s.yaml \
      --set agones.allocator.service.serviceType=ClusterIP \
      --set agones.ping.http.serviceType=ClusterIP \
      --set gameservers.minPort=7000 \
      --set gameservers.maxPort=8000