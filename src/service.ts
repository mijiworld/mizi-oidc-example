import { z } from 'zod';

/** A minimal projection of /v1/me; never retain the full upstream response. */
export const memberApiResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    fetchedAt: z.iso.datetime(),
    profile: z.object({
      id: z.string().min(1).max(255),
      nickname: z.string().max(500),
      githubConnected: z.boolean().nullable(),
    }),
  }),
  z.object({
    status: z.literal('error'),
    fetchedAt: z.iso.datetime(),
    reason: z.enum(['scope_missing', 'unauthorized', 'forbidden', 'unavailable', 'invalid_response']),
  }),
]);
export type MemberApiResult = z.infer<typeof memberApiResultSchema>;
export const projectGoalSchema = z.enum(['website', 'assistant', 'automation']);
export type ProjectGoal = z.infer<typeof projectGoalSchema>;

/** These plans belong to this example app, not to MiZi or a member's verified skills. */
export const PROJECT_PLANS: ReadonlyArray<{
  id: ProjectGoal; title: string; description: string; steps: readonly string[];
}> = [
  { id: 'website', title: '웹 서비스', description: '내 회원이 이용할 작은 웹 서비스를 시작해요.',
    steps: ['첫 화면과 회원에게 제공할 기능 하나를 정해요.', '미지 회원 ID를 내 서비스의 계정과 연결해요.', '로그인한 회원만 사용할 첫 기능을 만들어 봐요.'] },
  { id: 'assistant', title: 'AI 도구', description: '회원별로 설정을 기억하는 AI 도구를 시작해요.',
    steps: ['도구가 도와줄 작업 하나를 정해요.', '사용자의 설정을 내 서비스 계정에 저장해요.', '허용받은 데이터만 활용하는 대화 흐름을 만들어요.'] },
  { id: 'automation', title: '업무 자동화', description: '반복 작업을 줄이는 나만의 도구를 시작해요.',
    steps: ['반복되는 작업의 입력과 결과를 정해요.', '작업 설정을 내 서비스 계정에 저장해요.', '먼저 읽기 작업으로 동작을 확인한 뒤 확장해요.'] },
];
