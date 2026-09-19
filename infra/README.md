# AWS에 예제 앱 배포

서울 리전의 API Gateway HTTP API → Lambda(Node.js 24, ARM64) → DynamoDB 구성입니다.
HTTPS 도메인은 API Gateway의 Regional custom domain과 Route53 Alias를 사용합니다.
새 앱의 전용 스택을 만들며, 미지 인증 서버의 코드·설정·회원 DB는 수정하지 않습니다.

## 준비

- AWS CLI와 해당 계정의 배포 권한
- Route53에서 실제 위임된 도메인의 hosted zone
- 같은 AWS 리전에서 발급 완료된 ACM 인증서(데모 호스트를 포함)
- Node.js 24, pnpm, `zip`
- 원격 저장소에 게시할 코드의 검사 완료 및 Git 커밋

AWS 사용량에 따라 HTTP API, Lambda, DynamoDB, 로그, 아티팩트 저장 비용이 발생합니다.
앱은 요청 시 실행하며 상시 EC2 서버는 만들지 않습니다. HTTP API 기본 제한은 초당 5건,
순간 10건이고 로그는 7일 보존합니다. 실제 운영 서비스로 확장할 때는 부하와 요구에 맞춰
제한·모니터링·세션 저장소 정책을 조정하세요.

## 배포

먼저 `infra/artifacts.yml`로 비공개 S3 버킷을 만듭니다.

```bash
aws cloudformation deploy \
  --region ap-northeast-2 \
  --stack-name my-oidc-demo-artifacts \
  --template-file infra/artifacts.yml
```

스택 출력의 `ArtifactBucketName`과 여러분의 인프라 값을 지정합니다.
실제 계정 ID나 인증서 ARN은 소스 코드에 넣을 필요가 없습니다.

```bash
export AWS_PROFILE=your-profile
export AWS_REGION=ap-northeast-2
export STACK_NAME=my-oidc-demo
export DOMAIN_NAME=login-demo.example.com
export HOSTED_ZONE_ID=your-zone-id
export CERTIFICATE_ARN=your-issued-regional-certificate-arn
export ARTIFACT_BUCKET=your-private-artifact-bucket
bash scripts/deploy.sh
```

스크립트는 깨끗한 Git 커밋을 확인한 뒤 타입 검사·테스트·빌드, SHA별 ZIP 업로드,
CloudFormation 배포, `/health`의 배포 SHA 확인을 수행합니다. 같은 명령으로 이후
커밋을 배포할 수 있습니다. GitHub CI도 동일한 타입 검사·테스트·빌드를 수행합니다.
첫 HTTPS 도메인 전파를 기다리도록 health 확인은 최대 3분간 짧게 재시도합니다.
재시도 중에도 TLS 인증서 검증과 40자리 배포 SHA의 정확한 일치는 필수입니다.
이 예제는 GitHub에 장기 AWS 키를 저장하거나 자동 배포 권한을 만들지 않습니다.

`CLIENT_ID`는 배포 호스트의 `/client.json`으로 설정됩니다. 이 CIMD 문서와
`/auth/callback`을 같은 HTTPS 호스트에 제공하므로 별도 앱 등록은 필요 없습니다.
`OIDC_ISSUER`는 스택 파라미터 `OidcIssuer`이며 기본값은 운영 MiZi입니다.

## 확인

```bash
curl --fail https://login-demo.example.com/health
curl --fail https://login-demo.example.com/client.json
curl --fail https://login-demo.example.com/developers
```

브라우저에서 실제 로그인·동의를 완료한 뒤 로그인 결과를 확인하세요.
개발자 API 가이드는 로그인 없이 열리며, 방문만으로 회원 API나 세션 저장소를 조회하지 않습니다.
내 정보에서 소개·관심 분야를, 내 스킬에서 추가 동의 후 스킬 목록을 확인하세요.
가져온 스킬이 20개를 넘으면 **더 보기**로 20개씩 펼치고 마지막 항목까지 확인하세요.
이 동작은 저장된 목록만 표시하며 추가 동의나 프로젝트 선택 초기화가 없어야 합니다.
연결된 계정에서 **프로필 다시 가져오기**와 **스킬 다시 가져오기**가 미지 화면으로 이동하지
않고 해당 API만 조회하는지 확인하세요. 프로젝트 선택과 세션 ID·로그인 절대 한도는 유지되어야 합니다.
예전 세션에 서버 재조회 연결이 없다면 한 번 **다시 연결하기**가 필요합니다. 만료·권한
해제 시에도 자동으로 OAuth로 이동하지 않고 같은 버튼을 안내합니다. 실패 시 이전 조회
결과와 시각이 유지되는지, 프로필 일부 성공은 해당 결과만 갱신하는지 확인하세요.
각 API의 출처·조회 시각과 빈 결과·실패 상태를 구분하고, 프로젝트 보드에서 목표 선택 후
새로고침해 데모 세션에 선택이 남는지 확인하세요. 이 선택은 미지 API에 쓰지 않습니다.
비인증 상태의 공개 엔드포인트 검사와 실제 OIDC 로그인 성공은 서로 다른 검사입니다.

템플릿은 API Gateway 기본 execute-api 주소를 비활성화합니다. 앱 URL·콜백 URL은
설정된 HTTPS 호스트를 사용하며 요청의 Host 헤더로 만들지 않습니다.
접근 로그에는 요청 ID·메서드·라우트·상태·지연만 남기고 쿼리·쿠키·인가 코드를 넣지
않습니다. Lambda의 역할은 전용 세션 테이블의 Get/Put/Delete/Update와 전용 로그 쓰기만
허용합니다. 로그인 시도는 10분 뒤 만료합니다. 새 로그인은 30일 미사용·90일 절대 한도를
적용하며, 세션 발급 시각과 검증한 ID 토큰의 `auth_time`에서 각각 90일 중 이른 시각이
절대 상한입니다. 인증된 페이지 방문과 해당 POST는 미사용 기한과 영속 쿠키를 갱신하지만
절대 상한은 바꾸지 않습니다. 백그라운드 ping은 없습니다. 정책은
`src/session-policy.ts`의 `SESSION_IDLE_SECONDS`·`SESSION_ABSOLUTE_SECONDS`를 따릅니다.

추가 API 동의로 받은 접근·갱신 토큰은 같은 DynamoDB 테이블의 서버 전용 필드에만
보관하며 저장 시 암호화(SSE)를 사용합니다. ID 토큰은 보관하지 않습니다. 일반 세션
조회·HTML 화면 모델·브라우저·로그에는 토큰 원문을 전달하지 않습니다. 접근 토큰은 응답의
실제 `expires_in`(현재 3600초)을 따르고, 명시적인 다시 가져오기 POST에서 만료가 가까우면
서버가 갱신합니다. 분산 잠금과 조건부 저장으로 중복 갱신을 막고 회전된 최신 값을 보관합니다.
갱신은 앱 로그인 절대 한도를 연장하지 않습니다. 권한 취소·`invalid_grant`에는 자격을
제거하고 재연결을 안내하며 앱 로그인은 별도로 유지합니다. 통신 실패 시 이전 결과를 표시합니다.

로그아웃·계정 교체 시 이전 세션과 접근·갱신 토큰을 삭제합니다. DynamoDB TTL 삭제는
지연될 수 있지만 앱이 만료를 직접 검사하므로 삭제 대기 중인 세션·자격을 사용하지 않습니다.
프로젝트 목표는 같은 세션 항목에만 저장하고 조건부 Update는 유효기간·회원을 재검사합니다.
재조회는 세션 ID·프로젝트와 다른 화면의 요약을 유지합니다. 같은 회원으로 명시적 재연결하고
기본 회원 조회가 성공하면 유효한 기존 목표를 이어가지만, 만료된 세션이나 다른 계정의
정보를 복구하지 않습니다. 새 정책 필드가 없는 기존 세션은 종전 30분 만료를 유지하고
새 로그인부터 새 정책을 적용합니다. refresh token이 없는 연결은 한 번 재연결해야 합니다.
기존 항목을 자동으로 장기 세션으로 바꾸는 데이터 이전이나 새 인덱스는 필요 없습니다.

## 되돌리기와 제거

오류가 난 릴리스는 이전 Git 커밋을 별도 작업 디렉터리에 체크아웃하여 같은 배포
명령으로 다시 배포할 수 있습니다. 배포 SHA는 `/health`와 스택 출력에서 확인합니다.

데모를 종료할 때는 **이 예제의 스택 이름을 확인한 뒤** 앱 스택을 삭제합니다.
이 작업은 데모 도메인 레코드·Lambda·API·세션 테이블·로그를 삭제합니다. 기존 ACM
인증서와 Route53 hosted zone은 이 스택이 소유하지 않으므로 삭제하지 않습니다.
아티팩트 버킷은 실수로 배포 이력을 잃지 않도록 Retain 설정입니다. 보관이 필요 없으면
버킷의 모든 객체 버전·삭제 마커를 정리하고 버킷 및 아티팩트 스택을 별도로 삭제하세요.
