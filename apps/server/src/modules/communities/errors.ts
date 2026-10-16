export type CommunityErrorCode = 'COMMUNITY_NOT_FOUND' | 'COMMUNITY_REQUIREMENT_UNMET' | 'COMMUNITY_REVIEW_FORBIDDEN' | 'COMMUNITY_CONFIG_CONFLICT'
export class CommunityError extends Error {
  readonly publicMessage: string
  readonly statusCode: number
  constructor(readonly code: CommunityErrorCode) {
    const messages = {
      COMMUNITY_NOT_FOUND: [404, 'The requested community resource was not found.'],
      COMMUNITY_REQUIREMENT_UNMET: [403, 'Required community identity links are missing.'],
      COMMUNITY_REVIEW_FORBIDDEN: [403, 'Community access is not authorized.'],
      COMMUNITY_CONFIG_CONFLICT: [409, 'Community configuration has changed.'],
    } as const
    super(messages[code][1]); this.publicMessage = messages[code][1]; this.statusCode = messages[code][0]
  }
}
