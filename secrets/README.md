# secrets/

앱이 쓰는 비밀값(DB 비밀번호 등)을 **암호화된 SealedSecret으로만** 보관하는 폴더.

> 이 저장소는 public이다. 평문 Secret과 Sealed Secrets 열쇠(개인키)는 절대 올리지 않는다.
> 쿠버네티스 Secret은 base64일 뿐 암호화가 아니므로 그대로 올리면 누구나 읽을 수 있다.

## 동작 방식

```
[내 PC]                         [GitHub]                    [클러스터]
평문 Secret ─ kubeseal(잠금) ─▶ SealedSecret(암호문) ─ Argo CD ─▶ SealedSecret
  (파일로 저장하지 않음)          secrets/*.yaml                       │ 컨트롤러가 열쇠로 풂
                                                                       ▼
                                                               Secret (평문) ─ envFrom ─▶ 앱
```

- **컨트롤러**(`kube-system/sealed-secrets-controller`)가 열쇠 쌍을 갖고 있다. 공개키(자물쇠)는 누구나 받을 수 있고, 개인키(열쇠)는 클러스터 안에만 있다.
- `kubeseal`이 공개키로 잠근 값은 **그 클러스터의 개인키로만** 풀린다.
- 잠금은 `namespace + 이름`에 묶인다. `taxi-dev/taxi-db`로 잠근 값은 `taxi-prod`에서 풀리지 않으므로 환경마다 따로 만든다.
- 컨트롤러 설치 설정: `platform/sealed-secrets/values.yaml`

## 파일 목록

| 파일 | 만들어지는 Secret | 쓰는 곳 |
| --- | --- | --- |
| `taxi-dev-db.yaml` | `taxi-dev/taxi-db` (`DB_USERNAME`, `DB_PASSWORD`) | `apps/taxi` dev |
| `taxi-prod-db.yaml` | `taxi-prod/taxi-db` (`DB_USERNAME`, `DB_PASSWORD`) | `apps/taxi` prod |

> 두 파일은 P4 클러스터와 실제 DB 계정이 준비된 뒤 추가한다. kind에서 잠근 파일은 실제 클러스터에서 풀리지 않는다.

## 비밀값 잠그기 (새로 만들 때, 비밀번호를 바꿀 때)

클러스터에 kubeconfig로 접속할 수 있는 PC에서 실행한다. 평문은 파일로 저장하지 않고 바로 잠근다.

```bash
kubectl create secret generic taxi-db -n taxi-dev \
  --from-literal=DB_USERNAME=taxi_dev \
  --from-literal=DB_PASSWORD='<비밀번호>' \
  --dry-run=client -o yaml \
| kubeseal --format yaml > secrets/taxi-dev-db.yaml
```

PowerShell에서는 `>` 대신 `| Set-Content -Encoding ascii secrets\taxi-dev-db.yaml`을 쓴다. (`>`는 UTF-16으로 저장된다)

확인할 것:
- 파일에 평문 비밀번호가 없다 (`encryptedData` 아래 암호문만 있음)
- `metadata.namespace`와 `metadata.name`이 맞다

## 열쇠 백업

컨트롤러는 30일마다 새 열쇠를 **추가**한다(옛 열쇠는 지우지 않음). 새 열쇠가 생기면 백업도 다시 떠야 한다.
→ 정책: **처음 설치 직후 1회 + 매주 1회**, 호스트 PC 밖(팀 클라우드 드라이브)에 **암호화해서** 보관 (아키텍처 7장)

```bash
kubectl get secret -n kube-system -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml \
| grep -vE '^\s+(resourceVersion|uid|creationTimestamp):' > sealed-secrets-key-backup.yaml
```

PowerShell:

```powershell
kubectl get secret -n kube-system -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml |
  Where-Object { $_ -notmatch '^\s+(resourceVersion|uid|creationTimestamp):' } |
  Set-Content -Encoding ascii sealed-secrets-key-backup.yaml
```

- `resourceVersion`·`uid`·`creationTimestamp`는 원래 클러스터에서만 의미가 있어 복원을 방해하므로 뺀다.
- 결과 파일이 **개인키**다. 저장소 폴더에 두지 않는다(`.gitignore`로도 막아 둠).

## 열쇠 복원 (클러스터를 새로 만들 때)

**컨트롤러가 SealedSecret을 처리하기 전에** 열쇠를 넣어야 한다. 그래서 복원은 Argo CD가 아니라 클러스터 구성 단계(Ansible)에서 한다.

```bash
# 1) 열쇠 복원 (컨트롤러 설치 전)
kubectl apply -f sealed-secrets-key-backup.yaml

# 2) 컨트롤러 설치 → 켜지면서 복원된 열쇠를 읽는다
helm repo add sealed-secrets https://bitnami.github.io/sealed-secrets
helm install sealed-secrets sealed-secrets/sealed-secrets -n kube-system -f platform/sealed-secrets/values.yaml
```

컨트롤러가 이미 떠 있는 상태에서 복원했다면 다시 읽도록 재시작한다. 컨트롤러는 시작할 때만 열쇠를 읽는다.

```bash
kubectl rollout restart deploy/sealed-secrets-controller -n kube-system
```

## 확인

```bash
kubectl get sealedsecret,secret -n taxi-dev       # 같은 이름의 SealedSecret과 Secret이 짝으로 있어야 함
kubectl logs deploy/sealed-secrets-controller -n kube-system | grep -i decrypt
```

| 증상 | 원인 |
| --- | --- |
| Secret이 안 생기고 로그에 `no key could decrypt secret` | 다른 클러스터 열쇠로 잠갔거나, 열쇠 복원을 안 했음 |
| `already exists and is not managed by SealedSecret` | 같은 이름의 Secret을 손으로 만든 게 남아 있음 → 지우고 다시 적용 |
| 다른 namespace에서 안 풀림 | 잠금이 `namespace + 이름`에 묶여 있음 → 그 namespace로 다시 잠금 |

## kind 리허설 결과 (2026-10-08)

| 확인 | 결과 |
| --- | --- |
| 잠근 파일에 평문 없음 | 확인 |
| 적용하면 Secret `taxi-db` 생성, 값 일치 | 확인 |
| 생성된 Secret을 지워도 다시 생성 | 확인 |
| 열쇠를 지우고 재시작하면 기존 SealedSecret을 못 풂 | 확인 |
| 백업 열쇠를 복원하고 재시작하면 다시 풂 | 확인 |
