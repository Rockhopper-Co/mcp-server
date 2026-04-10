export interface Team {
    internalId: number;
    name: string;
    description: string | null;
    createdAt: string;
    updatedAt: string;
    teamMembers: TeamMember[];
}
export interface TeamMember {
    id: number;
    role: string;
    user: UserSummary;
    createdAt: string;
}
export interface UserSummary {
    internalId: number;
    firstName: string | null;
    lastName: string | null;
    email: string;
    username: string | null;
}
export interface Workspace {
    internalId: number;
    workspaceDescription: string | null;
    enrolledFiles: EnrolledFile[];
}
export interface EnrolledFile {
    internalId: number;
    platformId: string;
    fileType: string;
    driveMsId: string;
    name: string;
    hasUncommittedChanges: boolean | null;
}
export interface FileVersion {
    internalId: number;
    majorVersion: number;
    minorVersion: number;
    patchVersion: number;
    description: string | null;
    createdAt: string;
    wasDiscarded: boolean;
    wasReverted: boolean;
    byUserPlatformId: string | null;
    byUserPlatformType: string | null;
}
export interface FileChat {
    internalId: number;
    message: string;
    source: string;
    cellReference: string | null;
    resolved: boolean;
    authorName: string | null;
    authorEmail: string | null;
    createdAt: string;
    updatedAt: string;
    editedOn: string | null;
    replies?: FileChat[];
    byUser?: UserSummary | null;
}
export interface ReviewRequest {
    internalId: number;
    id: number;
    subject: string;
    description: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
    requester?: UserSummary;
    reviewRecords?: ReviewRecord[];
}
export interface ReviewRecord {
    id: number;
    status: string;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
    reviewer?: UserSummary;
}
export interface UnattributedChange {
    id: number;
    changeType: string;
    sheetName: string;
    cellAddress: string;
    oldValue: unknown;
    newValue: unknown;
    byUserPlatformId: string | null;
    byUserPlatformType: string | null;
    processingStatus: string;
    attributionDate: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface CellHistoryEntry {
    versionId: number;
    value: unknown;
    changedBy: string | null;
    changedAt: string;
}
export interface ReviewActivity {
    id: number;
    action: string;
    createdAt: string;
    user?: UserSummary;
}
//# sourceMappingURL=types.d.ts.map