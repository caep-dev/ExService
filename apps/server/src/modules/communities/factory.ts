import { CommunityService, type CommunityDependencies } from './service.js'
export function createCommunityServices(dependencies: CommunityDependencies): CommunityService { return new CommunityService(dependencies) }
