// k6 부하: Canary 단계마다 Gateway를 거쳐 일정한 양의 요청을 보낸다. (CD 가이드 8단계)
// 실제 사용자가 없으므로 판정에 쓸 요청을 이 Job이 만든다. 판정은 Prometheus 지표로 하고,
// k6는 요청만 보낸다(에러가 나도 k6 자체는 성공으로 끝남).
//
// 요청량: Gateway가 weight만큼만 새 버전으로 보내므로, 가장 낮은 단계(10%)에서도
// 새 버전이 받는 요청이 판정 최소치(200건/1분)를 넘어야 한다.
//   RATE 50/s × 60초 × 10% = 300건  (RATE 10이면 60건 → 매번 판정 불가)
import http from 'k6/http';
import { sleep } from 'k6';

const BASE = __ENV.TARGET_URL;              // Gateway 주소 (MetalLB VIP)
const HOST = __ENV.TARGET_HOST;             // prod 호스트 이름. Gateway가 이 이름으로 prod 창구를 고른다
const RATE = Number(__ENV.RATE || 50);      // 초당 요청 수
const VUS = Math.max(10, RATE);             // 동시에 요청을 보낼 가상 사용자 수 (응답이 느려지면 maxVUs까지 늘어남)

export const options = {
  scenarios: {
    canary: {
      executor: 'constant-arrival-rate',    // 응답이 느려져도 초당 요청 수를 일정하게 유지
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '150s',
      preAllocatedVUs: VUS,
      maxVUs: VUS * 4,
    },
  },
};

// 조회에 쓸 사용자 1명을 만든다. 일부 요청은 새 버전으로 가서 실패할 수 있으므로 몇 번 재시도한다.
export function setup() {
  for (let i = 0; i < 10; i++) {
    const phone = '010' + String(Date.now()).slice(-8);
    const res = http.post(
      `${BASE}/api/v1/users`,
      JSON.stringify({ name: 'k6', phone: phone, role: 'PASSENGER' }),
      { headers: { 'Content-Type': 'application/json', Host: HOST } },
    );
    if (res.status === 201) return { userId: String(res.json('id')) };
    sleep(1);
  }
  throw new Error('조회용 사용자를 만들지 못했습니다');
}

export default function (data) {
  http.get(`${BASE}/api/v1/me`, {
    headers: { Host: HOST, 'X-User-Id': data.userId },
    timeout: '5s',
  });
}
