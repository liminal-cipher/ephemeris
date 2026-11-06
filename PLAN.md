# Ephemeris 일상 작업 공간 확장

## 범위와 기준

2026-11-07 사용자 요청의 A–G 순서로 검증 가능한 기능을 완성한다.
기준은 `03c8e5b`이며 fetch 후 local main과 remote main은 동일했다.
이전 동기화 후속 작업 3개 커밋은 별도 승인으로 푸시되었다.
사용자는 구현 후 이번 변경을 의미 단위로 커밋하고 main에 푸시하도록 별도 승인했다.
배포·릴리스·서명은 승인 범위에 포함되지 않는다.
실제 사용자 Vault, 계정, 비밀, 다른 저장소는 수정하지 않는다.

## 구현 순서와 수용 기준

| 단계 | 사용자에게 제공할 결과 | 검증과 완료 조건 |
| --- | --- | --- |
| A 호환성과 신뢰성 | macOS 임시 경로 오류 수정, 운영 경로 보호 유지, 편집기 취약 의존성 개선 | CI 로그와 재현, 별칭 허용/거부 회귀, 기존 테스트. macOS 실제 실행은 별도 증거 필요 |
| B 일상 편집 | 별도 선택한 Native Vault의 생성·편집·이름 변경·이동·휴지통·복원. 브라우저 작업 공간 유지 | 짧은 쓰기 권한, CSRF/origin 검증, CAS 충돌, 재시작 후 미저장 초안 복구, IME·키보드·첨부파일·새로고침 E2E |
| C 지식 관리 | Quick Capture, Daily Notes, 속성·태그, 탐색과 저장된 뷰 | 동일 Vault 위의 조회/편집, 날짜·검색·필터·빈 상태, UI 검증 |
| D 교환과 복구 | 명시적 Markdown 입출력과 원본 보존, 이력·충돌 조회와 복구 | 지원 범위 미리보기, 한국어·링크·수식·미지원 요소 왕복, 비파괴 복원 |
| E 에이전트 연결 | 명시적 Vault의 읽기 전용 stdio MCP | 실제 하위 프로세스 JSON-RPC, 허용 도구·페이지·출력 상한, 임의 파일/SQL 거부 |
| F 규모와 확장 | 합성 대용량 Vault 측정, 측정된 병목 개선 | 수천 메모·깊은 계층·검색·편집·복구 측정. 이력 자동 삭제 금지 |
| G 플랫폼 수용 | Windows/macOS 실행 경로와 배포 방식 비교 | Chromium/Firefox/WebKit 실제 UI, 스크린샷 검토, OS별 PASS/FAIL/NOT RUN. 서명·공개 배포 없음 |

## 데이터와 보안 계약

- Native SQLite의 Yjs가 원본이다. 브라우저 IndexedDB 원본을 자동 이관하지 않는다.
- 미전송 초안은 복구 자료이며 다른 원본 저장소로 취급하지 않는다. 저장 성공은
  서버 확인 이후에만 표시한다. 충돌을 자동 덮어쓰거나 원본 구조를 제거하지 않는다.
- 기존 읽기 토큰은 읽기만 허용한다. 쓰기는 명시적 별도 권한과 짧은 만료,
  loopback·정확한 Origin/Host·인증·JSON 크기 제한·낙관적 버전을 적용한다.
- 기존 HTTP 동기화 provider와 보존 규칙을 재사용한다. 실제 자격 증명과
  합성 테스트는 분리한다. 네트워크·AI·플러그인 실행은 기본 비활성이다.
- 미지원 문서를 편집기에 강제로 넣지 않는다. 원본 다운로드와 명확한 사유를 제공한다.
- 각 단계 후 기존 문서와 CURRENT_TASK에 증거와 한계를 갱신한다.

## 확인된 기준 상태

- CI `42231015207`: Ubuntu·Windows 성공. macOS native 121개 중 19개 실패,
  모두 `vault.test.js`의 비정규화된 `tmpdir()` 경로에서 발생했다.
- 임시 경로 별칭을 주입하여 Windows에서도 동일 오류를 재현했다.
  신뢰된 fixture root만 `realpathSync(tmpdir())`로 바꾼 후 관련 21개 테스트 PASS.
  새 코드의 실제 macOS 실행은 NOT RUN이다.
- 최초 의존성 감사는 moderate 31, low 1이었다. Tiptap 3.33·math 1.4와
  KaTeX 의존성 정리 후 현재 감사는 0건이다. 수식/Yjs/프로토타입 공격 회귀 PASS.

## 이번 로컬 구현 결과와 다음 단계

- A: 신뢰된 임시 fixture만 정규 경로로 변경했다. 운영 symlink 거부 유지.
  Windows native 전체 132개 PASS. 수정본 macOS/Linux CI는 아직 NOT RUN이다.
- B: 권한이 분리된 Native 편집, CAS, CRUD·첨부·저장 상태·IME 이벤트·포커스,
  충돌 비교와 사본 복구를 구현했다. strict IndexedDB 초안은 실제 Chromium
  강제 종료 후 복구·SQLite 저장 PASS. 전원 장애와 OS IME 수동 수용은 미검증이다.
- C: Quick Capture, Daily Note, 회의 template, 태그·프로젝트·상태·기한·즐겨찾기,
  표·카드·칸반·저장된 뷰를 구현했다. 조회 중 입력한 필터가 늦은 응답으로
  되돌아가던 문제와 저장 이후 실행 취소 묶음 경계도 회귀 테스트로 보완했다.
- D: 기존 JSON/native snapshot 이관·복구와 새 편집 충돌 UI는 유지·검증했다.
  Markdown/YAML/Obsidian/Joplin codec과 원본 보존·왕복 검증, 전체 revision/sync
  UI는 다음 작업이다. 미지원 구조를 손실 변환하는 임시 importer는 만들지 않았다.
- E: 7개 읽기 도구의 local stdio MCP를 구현하고 실제 subprocess로 검증했다.
- F: 3,000개 메모·256단계 계층·두 handle의 100회 편집·8MiB 첨부·백업·복원을
  측정했다. 검색 중앙값 30.12ms, 최근 변경 뷰 21.87ms로 개선했다. 환경과
  초기 동시 부하 한계는 docs/sync-benchmarks에 기록했다. 이력 삭제는 없다.
- G: 세 브라우저 엔진을 Windows에서 자동화하고 실제 스크린샷을 검토했다.
  Electron/Tauri/Companion 비교는 native-vault 문서에 있다. 설치기·서명·배포,
  실제 macOS·Linux·Safari 수용은 남았다. 역사적 Phase C와 전체 2.0은 미완료다.

구체적 변경 파일, 실행 명령, 결과, 사용·복구 절차는
`docs/ephemeris-2-handoff.md`의 2026-11-07 절이 기준이다.
