# 레드롭 코드

레드롭 코드: 터미널에서 쓰는 AI 코딩 에이전트.

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a>
</p>

[![레드롭 코드 터미널 UI](packages/identity/screenshot.png)](https://github.com/redrob-labs/redrob-code)

---

레드롭 코드는 [opencode](https://github.com/anomalyco/opencode)의 포크이며 MIT 라이선스로
배포됩니다. opencode 프로젝트 및 그 관리자와 제휴, 보증, 지원 관계가 없습니다. 이름은
이 소프트웨어의 출처를 밝히기 위해서만 사용합니다.

포크가 바꾼 것은 세 가지입니다. 공급자 모델을 벤더별 키가 아닌 하나의 레드롭 워크스페이스
엔드포인트로 바꿨고, 한국어를 일급 로케일로 다루며, 호스팅 콘솔이 아닌 터미널 클라이언트에
맞게 패키지를 줄였습니다. 릴리스는 `0.1.0` 부터 시작하는 자체 버전 체계를 사용합니다.
빌드가 기반한 상류 버전은 `UPSTREAM_VERSION` 에 기록되고 릴리스 노트에 표시됩니다.
자세한 내용은 `docs/VERSIONING.md` 를 참고하세요.

### 설치

```bash
curl -fsSL https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install | bash
```

이 저장소의 [`install`](./install) 을 그대로 내려받으므로, 실행하는 스크립트를 여기서 읽어볼 수
있습니다. 아래 순서에서 처음으로 쓸 수 있는 경로를 선택합니다.

1. `$REDROB_INSTALL_DIR`: 직접 지정한 경로
2. `$XDG_BIN_DIR`: XDG Base Directory 경로
3. `$HOME/bin`: 이미 있거나 생성할 수 있으면 사용
4. `$HOME/.redrob/bin`: 기본 폴백

```bash
REDROB_INSTALL_DIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install | bash
```

설치 후 아무 프로젝트에서 실행합니다.

```bash
redrob
```

### 인증

레드롭 코드는 <https://console.redrob.ai>의 레드롭 콘솔과 통신하며 워크스페이스 API 키로
인증합니다. 비밀번호 로그인이나 루프백 OAuth 콜백은 없습니다.

키를 기기에 넣는 가장 빠른 방법은 콘솔이 직접 발급하도록 맡기는 것입니다.

```bash
redrob providers login --provider redrob
```

**Connect Redrob**을 선택하면 CLI가 `K7QM-2XR9` 같은 짧은 코드를 보여 주고, 브라우저가 있는
기기라면 <https://console.redrob.ai/connect>를 엽니다. 콘솔에 로그인해 그 코드를 승인하면
CLI가 발급된 키를 받아 옵니다. 실행 중인 세션에서는 `/connect` 창에 같은 항목이 있습니다.

RFC 8628 기기 인증 방식이므로 SSH, 컨테이너, 브라우저가 없는 호스트에서도 동작합니다.
휴대폰이나 다른 노트북에서 그 페이지를 열어도 됩니다. 코드는 10분간 유효합니다. 승인하면
콘솔 키 목록에서 취소할 수 있는 일반 워크스페이스 API 키가 만들어집니다. 크레딧은 추가되지
않습니다.

키를 직접 붙여 넣는 방법도 그대로 있습니다. 기기에서 콘솔에 접속할 수 없거나 키를 다른
경로로 받은 경우에 사용하세요. **Paste an API key from console.redrob.ai**를 선택하거나 환경
변수를 지정합니다.

```bash
export REDROB_API_KEY=rrk_<prefix>_<secret>
```

어느 쪽이든 자격 증명은 같은 위치, 즉 레드롭 데이터 디렉터리의 `auth.json`에 본인만 읽을 수
있는 권한으로 저장됩니다. `redrob providers list`가 정확한 경로를 알려 줍니다.

### 모델

레드롭 콘솔이 유일한 공급자입니다. 모델 목록은 시작할 때
`GET https://console.redrob.ai/api/backend/v1/models`에서 가져오므로 CLI를 업그레이드하지
않아도 새 모델이 나타납니다. 현재 키로 쓸 수 있는 모델을 확인하려면,

```bash
redrob models
```

현재 제공되는 모델은 다음과 같습니다.

| 모델                     | 용도                                          |
| ------------------------ | --------------------------------------------- |
| `redrob/auto`            | 콘솔이 요청마다 모델을 고르는 기본값          |
| `redrob/gpt-5.6-sol`     | GPT-5.6 Sol. OpenAI 계열 상위 모델            |
| `redrob/gpt-5.6-terra`   | GPT-5.6 Terra. 더 저렴한 GPT-5.6 등급         |
| `redrob/claude-opus-5`   | Claude Opus 5. 코딩·에이전트 작업에 가장 강력 |
| `redrob/claude-sonnet-5` | Claude Sonnet 5. 균형 잡힌 코딩               |
| `redrob/claude-fable-5`  | Claude Fable 5. 긴 글쓰기                     |

기본값은 `redrob/auto`입니다. 세션에서 다른 모델을 쓰려면
`redrob --model redrob/claude-opus-5`를 사용하세요.

`redrob-ai`와 `redrob-translate`는 폐기되었으며 더 이상 유효한 모델 id가 아닙니다. 아직 이
id를 쓰는 설정·에이전트·명령은 `redrob/auto`로 바꾸세요.

### 에이전트

기본 에이전트 2개가 내장되어 있고 `Tab` 키로 전환합니다 (`Shift+Tab`은 역방향).

- **build**: 기본 에이전트. 설정된 권한에 따라 도구를 실행합니다
- **plan**: 모든 편집 도구를 거부합니다. 분석과 코드 탐색에 적합합니다

서브에이전트 2개는 메시지에서 직접 호출할 수 있습니다.

- **`@general`**: 여러 단계에 걸친 조사와 병렬 작업
- **`@explore`**: 빠른 코드베이스 검색과 파악

### 설정

| 범위     | 경로                                                     |
| -------- | -------------------------------------------------------- |
| 전역     | `~/.config/redrob/redrob.json` 또는 `redrob.jsonc`       |
| 프로젝트 | `./redrob.json` 또는 `./redrob.jsonc`, 그리고 `.redrob/` |

프로젝트 설정이 전역 설정 위에 병합됩니다. 에이전트에게 설정 파일을 수정하라고 요청하면
실제 스키마가 담긴 내장 스킬을 불러오므로, `redrob`이 자기 설정을 직접 구성할 수 있습니다.

`.opencode/`는 이전 체크아웃 호환을 위해 계속 읽지만, 새 파일은 `.redrob/`에 두세요.

### 범위

레드롭 코드는 엔진, CLI, 터미널 UI 그리고 그 위에 올라가는 SDK와 플러그인
표면입니다. 자체 그래픽 인터페이스는 제공하지 않습니다. 데스크톱 셸도, 웹 UI도,
브라우저 프런트엔드도 없습니다.

**레드롭 워크가 유일한 GUI입니다.** `redrob serve`가 노출하는 HTTP API로 이
엔진을 구동하며, 요청마다 `x-redrob-directory` 헤더로 프로젝트를 선택합니다.
API, ACP, MCP 표면이 두 제품 사이의 계약이므로 안정적으로 유지해야 합니다.

### 개발

```bash
bun install
bun dev                      # 소스에서 CLI 실행
bun typecheck                # 전체 패키지
cd packages/core && bun test # 테스트는 패키지 디렉터리에서 실행 (저장소 루트 금지)
```

`bun@1.3.14`이 필요하며 pre-push 훅이 이를 검사합니다.

브랜치 모델, 풀 리퀘스트 방법, 그리고 상류 릴리스를 흡수하는 절차는
[docs/BRANCHING.md](./docs/BRANCHING.md)에 있습니다. 마지막 항목이 포크에서 가장
중요하면서 가장 틀리기 쉬운 작업입니다.
