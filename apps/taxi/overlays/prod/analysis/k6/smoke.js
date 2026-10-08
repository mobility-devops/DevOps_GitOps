// Smoke Test: 트래픽을 넣기 전에(weight 0) 새 버전에 직접 요청해서 기본 동작을 확인한다. (CD 가이드 8단계)
// taxi-canary Service는 새 버전 Pod만 가리키므로, 지금 서비스 중인 버전과 섞이지 않는다.
// 하나라도 실패하면 k6가 실패 코드로 끝나고 → Job 실패 → 분석 실패 → 자동 롤백.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.TARGET_URL || 'http://taxi-canary';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },      // check가 하나라도 실패하면 k6 종료 코드가 0이 아니게
};

export default function () {
  // 1) 요청을 받을 준비가 됐나 (Pod이 막 떠서 잠깐 안 될 수 있어 몇 번 기다린다)
  let ready;
  for (let i = 0; i < 10; i++) {
    ready = http.get(`${BASE}/actuator/health/readiness`);
    if (ready.status === 200) break;
    sleep(3);
  }
  check(ready, { 'readiness 200': (r) => r.status === 200 });

  // 2) 가입
  const phone = '010' + String(Date.now()).slice(-8);
  const created = http.post(
    `${BASE}/api/v1/users`,
    JSON.stringify({ name: 'smoke', phone: phone, role: 'PASSENGER' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (!check(created, { '가입 201': (r) => r.status === 201 })) return;

  // 3) 방금 가입한 사용자로 조회
  const me = http.get(`${BASE}/api/v1/me`, { headers: { 'X-User-Id': String(created.json('id')) } });
  check(me, { '조회 200': (r) => r.status === 200 });
}
