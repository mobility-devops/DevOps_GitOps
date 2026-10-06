# DevOps_GitOps

택시 배차 서비스 DevOps 프로젝트의 **배포 상태 저장소**.
클러스터에 무엇이 떠 있어야 하는지를 Kustomize로 적어 두면 **Argo CD**가 클러스터를 그 상태로 맞춘다.
배포 이력은 커밋으로 남고, 커밋을 되돌리면 롤백된다.

> 설계 기준: 노션 「프로젝트 아키텍처」 6장(CD 흐름)·10장(저장소와 브랜치).
> 문서는 DevOps_Docs의 [프로젝트 아키텍처](https://github.com/mobility-devops/DevOps_Docs/blob/main/architecture/project-architecture.md).

## 상태

아직 구조를 만들지 않았다. 아래는 만들 구조다.

## 폴더 구조 (예정)

```text
.github/     CODEOWNERS (dev 폴더 외 전체를 DevOps Project Team 소유로)
argocd/      Application 정의 (App of Apps 루트 포함)
apps/taxi/   base(공통) + overlays(dev, prod)
platform/    Gateway API, Envoy Gateway, cert-manager, MetalLB, metrics-server,
             PriorityClass, Calico 정책, 수집 에이전트(Alloy, kube-state-metrics)
secrets/     암호화된 SealedSecret만
```

## 배포 흐름

| 환경 | 누가 바꾸나 | 반영 |
|---|---|---|
| dev (`apps/taxi/overlays/dev/`) | Jenkins가 이미지 digest를 바꾸는 PR을 만들고 자동 머지 | Argo CD가 바로 교체 |
| prod (`apps/taxi/overlays/prod/`) | Jenkins가 PR 생성 → 작성자가 아닌 팀원 1명이 승인·머지 | Argo Rollouts Canary(10% → 30% → 60% → 100%), 실패 시 자동 롤백 |

- Argo CD는 webhook 없이 기본 주기(약 3분)로 변경을 감지한다. 저장소가 public이라 별도 키 없이 읽는다.
- 처음에는 Calico와 Argo CD만 클러스터에 직접 설치하고, 루트 Application 하나를 등록하면 나머지가 설치된다.

## 규칙

- **이미지는 digest로 지정한다.** 태그(`dev-SHA`, `vX.Y.Z`)는 이름표로만 쓰고 `latest`는 쓰지 않는다.
- **비밀값은 SealedSecret으로만** 올린다. 평문 Secret을 커밋하지 않는다.
- `main` 하나. PR 필수, 강제 push 금지, Squash 머지.
- 승인은 0명이지만 `apps/taxi/overlays/dev/` 밖의 변경은 **CODEOWNERS(DevOps Project Team) 승인이 필수**다.
  base·platform 변경도 prod에 바로 반영되기 때문이다.
  ```text
  *                          @mobility-devops/devops-project-team
  /apps/taxi/overlays/dev/
  ```
- Canary 롤백 후에는 되돌림 PR(또는 수정 PR)이 머지될 때까지 prod 폴더에 다른 머지를 하지 않는다.

## 관련 저장소

| 저장소 | 역할 |
|---|---|
| [DevOps_Backend](https://github.com/mobility-devops/DevOps_Backend) | 앱 코드, Dockerfile, Jenkinsfile |
| **DevOps_GitOps** (이 저장소) | 배포 상태(Kustomize, Argo CD) |
| [DevOps_Infra](https://github.com/mobility-devops/DevOps_Infra) | VM(Vagrant)과 서버 설정 |
| [DevOps_Docs](https://github.com/mobility-devops/DevOps_Docs) | 설계·운영 문서, 회의 기록 |
