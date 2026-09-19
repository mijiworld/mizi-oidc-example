# MiZi OIDC Example

별도 웹앱에서 **미지로 로그인 → 동의한 미지 API 조회 → 내 서비스 제공**을 체험하는 예제입니다. 검증한 회원 정보로 자체 세션을 만들고, 선택적으로 회원 API를 연결해 나만의 프로젝트 시작 보드를 저장합니다.

**[라이브 데모](https://oidc-demo.cccv.to)** · **[MiZi OIDC 가이드](https://mcp-auth.cccv.ai/developer/guide/oidc)** · **[공개 Discovery](https://mcp-auth-api.cccv.ai/.well-known/openid-configuration)**

TypeScript · Hono · openid-client · jose · Node.js. 로컬에서는 메모리, AWS에서는 DynamoDB로 일회용 로그인 시도와 로그인 세션을 저장합니다.

## 라이브에서 확인할 것

1. 데모의 **미지로 로그인**을 누릅니다.
2. 미지 계정으로 로그인하고 회원 식별·닉네임 제공에 동의합니다. 이미 유효한 미지 로그인 세션이 있으면 다시 로그인하지 않을 수 있습니다.
3. 데모로 돌아오면 닉네임, 회원 ID, ID 토큰 검증 결과, 회원 조회 결과의 일치를 확인합니다.
4. **미지 프로필 연결하기**를 누르고 `user:profile` 추가 권한에 동의합니다. 데모 서버가 `GET /v1/me`를 호출하고 닉네임·GitHub 연결 상태와 조회 시각을 표시합니다. API의 회원 ID가 로그인한 회원과 같은지도 검사합니다.
5. **웹 서비스 · AI 도구 · 업무 자동화** 중 목표를 고릅니다. 이 데모가 준비한 시작 계획과 선택한 목표를 데모 세션에 저장합니다. 새로고침해도 유지되며, 미지에는 쓰기 요청을 보내지 않습니다.
6. **이 데모에서 로그아웃**한 뒤 같은 미지 계정으로 다시 로그인해 같은 회원 ID인지 확인합니다. 최초 동의에서 거절하는 경우 데모의 로그인 세션이 만들어지지 않아야 합니다. 이미 동의한 앱은 다음 연결 때 동의 화면을 생략할 수 있습니다.

화면에 표시하는 성공 결과는 실제 코드 교환·ID 토큰 검증·UserInfo 호출이 끝난 뒤에만 생성합니다. 운영 로그인 성공은 실제 브라우저로 동의한 결과로 확인하며, 자동 테스트 결과와 구분합니다.

<a id="quickstart"></a>
## 빠른 시작

Node.js **24 LTS**와 pnpm 9.4.0을 권장합니다. Node.js 20.20 이상도 실행할 수 있습니다.

```bash
git clone https://github.com/mijiworld/mizi-oidc-example.git
cd mizi-oidc-example
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

1. [MiZi 개발자 센터 → OAuth 클라이언트](https://mcp-auth.cccv.ai/developer/oauth-clients)에서 공개 클라이언트를 만듭니다.
2. 돌아올 주소를 **`http://localhost:3000/auth/callback`**으로 등록합니다. 포트·경로까지 정확히 일치해야 합니다.
3. 발급받은 `mzp_…` 값을 `.env`의 `CLIENT_ID`에 넣습니다.
4. `pnpm dev`를 실행하고 [localhost:3000](http://localhost:3000)을 엽니다.

3000번 포트가 사용 중이면 `PORT`, `BASE_URL`, 등록한 콜백 URL의 포트를 함께 바꾸세요.

이 예제는 **public client + PKCE**이므로 client secret이 필요 없습니다. 첫 로그인은 `openid profile`만 요청합니다. 로그인 후 회원 API 연결을 선택하면 `openid profile user:profile`로 추가 동의를 받습니다. 등록형 클라이언트에서도 이 세 scope를 사용할 수 있도록 설정하세요. `user:profile`은 미지의 프로필 읽기 권한이며, 이 예제의 실제 호출은 `/v1/me` 하나로 제한됩니다. `/v1/me/profile`, 연락처·지역·스킬 API는 호출하지 않습니다. 토큰 교환과 회원 조회는 예제 서버에서 처리하므로 브라우저 CORS 허용 출처를 추가할 필요가 없습니다.

라이브 데모는 [자체 CIMD 문서](https://oidc-demo.cccv.to/client.json)를 client ID로 사용합니다. CIMD는 앱을 확인하는 방식이고, 이 예제의 로그인 흐름은 OIDC입니다. 로컬 `localhost`의 CIMD 문서는 미지 서버가 조회할 수 없으므로 위의 사전 등록한 공개 클라이언트를 사용합니다.

## 로그인 흐름

```mermaid
sequenceDiagram
  actor U as 사용자
  participant A as 예제 앱
  participant M as MiZi 인증 서버
  U->>A: 미지로 로그인
  A->>A: state · nonce · PKCE 일회용 저장
  A-->>U: MiZi 인가 주소로 이동
  U->>M: 로그인 및 동의
  M-->>U: code · state · iss로 앱에 복귀
  U->>A: /auth/callback
  A->>M: code + PKCE verifier 교환
  M-->>A: ID 토큰 + 접근 토큰
  A->>A: 공개키 서명 및 로그인 요청 검증
  A->>M: 접근 토큰으로 UserInfo 조회
  M-->>A: sub · nickname
  A->>A: 회원 ID 일치 확인 후 자체 세션 생성
  A-->>U: 로그인 완료 및 검증 결과
```

검증은 `openid-client`의 프로토콜 처리와 `jose`의 명시적 RS256 서명 검증을 함께 사용합니다. 발급자(`iss`), 대상 앱(`aud`), 유효기간, `nonce`, 접근 토큰 해시(`at_hash`), 콜백의 `state`·`iss`, UserInfo의 `sub`를 확인합니다. 라이브러리의 검증을 통과하기 전에 앱 로그인 세션을 만들지 않습니다.

## 로그인 다음에 API와 서비스를 연결하기

화면은 로그인 완료, 회원 API 조회, 자체 프로젝트 보드의 세 단계를 구분합니다. 기존 로그인 세션도 추가 연결 버튼부터 이어서 사용할 수 있습니다.

- **로그인 증명:** `ID token`으로 미지 회원임을 확인합니다.
- **추가 API 권한:** 별도 버튼에서 `user:profile`을 요청합니다. API 요청에는 `access_token`을 사용하며 ID 토큰을 보내지 않습니다.
- **실제 읽기:** 코드 교환에서 `resource=https://mcp-auth-api.cccv.ai/v1/me`를 지정합니다. 서버는 openid 토큰에 UserInfo 대상도 함께 넣습니다. 현재 `/v1/me`는 scope와 토큰 유효성·연결 취소를 검사하며, 이 resource 값을 별도로 강제하는 API 식별자로 설명하지 않습니다.
- **응답 검증:** `/v1/me`의 `id`와 검증한 `sub`를 비교하고 Zod로 응답을 검증합니다. `nickname`, `github_connected`, 회원 ID와 조회 시각만 추립니다. GitHub 상태를 알 수 없을 때는 미연결로 바꾸지 않습니다.
- **자체 서비스:** 프로젝트 목표와 시작 계획은 이 데모의 기능입니다. 선택은 `/service/goal`을 통해 데모의 세션 저장소에만 기록합니다. 계획은 고정 예시이며 미지가 추천하거나 검증한 역량을 의미하지 않습니다.

```text
브라우저 → 데모 Lambda → 미지 /v1/me (Bearer access_token)
                    → 필요한 회원 정보만 추림
브라우저 → 데모 Lambda → 데모 DynamoDB에 프로젝트 목표 저장
```

API 응답은 **조회 당시의 요약**입니다. 토큰은 콜백 처리 중에만 사용하고 폐기하므로, 새로 읽으려면 프로필 연결을 다시 시작합니다. 권한 없음·만료·통신 실패·잘못된 응답은 API 실패 상태로 표시하고 보드 저장을 허용하지 않습니다. API 조회가 실패해도 이미 검증한 로그인 상태는 유지할 수 있습니다. 다른 회원의 응답이 섞인 경우에는 새 로그인을 실패 처리합니다.

목표는 현재 데모 세션의 남은 기간에만 저장되며, 선택을 바꿔도 30분 만료를 연장하지 않습니다. 로그아웃·재로그인·프로필 재연결 시 이전 보드는 초기화됩니다. 계정을 바꾸면 이전 회원 정보나 목표를 새 계정에 넘기지 않습니다. 미지에서 연결을 해제해도 이미 저장된 요약과 데모 세션이 즉시 사라지는 것은 아니므로, 즉시 지우려면 데모에서도 로그아웃하세요.

## 코드 찾기

- [`src/`](src): 설정, 로그인 라우트, OIDC 검증, 세션 저장, 화면을 역할별로 분리한 구현
- [`src/member-api.ts`](src/member-api.ts): Bearer 토큰을 사용하는 실제 회원 API 조회와 최소 응답 추출
- [`src/service.ts`](src/service.ts): 미지 데이터와 구분되는 데모 자체의 목표·시작 계획
- [`test/`](test): 정상 로그인과 잘못된 콜백·토큰·재사용을 검증하는 테스트
- [`infra/template.yml`](infra/template.yml): Lambda + HTTP API + DynamoDB + HTTPS 도메인
- [`infra/README.md`](infra/README.md): AWS 배포·확인·삭제 절차

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

## 세션과 데이터

- 로그인 시도는 10분 뒤, 데모 로그인 세션은 30분 뒤 만료됩니다. DynamoDB의 지연된 TTL 삭제와 별개로 앱에서 매 요청마다 만료를 검사합니다.
- 브라우저 쿠키에는 무작위 세션 식별자만 저장합니다. 운영 쿠키는 `__Host-` 접두사, `Secure`, `HttpOnly`, `SameSite=Lax`를 사용합니다.
- 접근·갱신·ID 토큰 원문은 검증 후 보관하지 않으며 화면·로그·GitHub에 기록하지 않습니다. 데모 세션에는 회원 ID·닉네임과 검증 결과, 선택적으로 API의 최소 조회 결과와 데모 프로젝트 목표만 남깁니다.
- **데모 로그아웃은 이 앱의 세션만 끝냅니다.** 미지 자체의 로그인 상태나 다른 앱 연결을 해제하지 않습니다. 미지에 허용한 연결은 미지 설정에서 별도로 관리할 수 있습니다.
- ID 토큰의 수명과 예제 앱의 로그인 세션 수명은 별개입니다. 이 예제는 토큰 갱신·SSO 전역 로그아웃·계정 삭제를 구현하지 않습니다.

홈 문서의 `Referrer-Policy` 헤더와 HTML meta는 `strict-origin`을 사용합니다. `no-referrer`는 브라우저의 폼 POST에서 `Origin: null`을 만들 수 있어, 정상 로그인·로그아웃도 엄격한 Origin 검사에 막히기 때문입니다([Fetch 표준](https://fetch.spec.whatwg.org/#append-a-request-origin-header)). 홈에서 경로·쿼리는 Referer로 전달하지 않으며, 로그인·로그아웃 리다이렉트와 콜백·HTTP 오류 응답은 `no-referrer`를 유지합니다. POST는 여전히 설정한 `BASE_URL`과 정확히 일치하는 Origin만 허용합니다.

## 연동 범위

이 저장소는 Authorization Code + PKCE(S256) OIDC 연동을 보여주는 참고 구현입니다. OIDC 전체 옵션 지원이나 미지 인증 서버의 OpenID 인증 획득을 의미하지 않습니다. 라이브 데모에서 쓰는 미지 계정은 실제 계정입니다.

보안 결함을 제보할 때는 토큰·쿠키·인가 코드나 개인 회원 정보를 공개 이슈에 붙이지 마세요. 대신 재현 단계와 비밀을 제거한 오류 정보를 제공하세요.

## 표준과 라이브러리

- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)
- [PKCE — RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)
- [openid-client](https://github.com/panva/openid-client)
- [jose](https://github.com/panva/jose)

MIT 라이선스. 코드를 복사하거나 수정해 여러분의 서비스에 사용할 수 있습니다.
