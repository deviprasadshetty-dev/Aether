export interface TaskNode {
    id: string;
    action: string;
    url: string;
    timestamp: string;
    parentId?: string;
    status: "success" | "failure" | "pending";
    error?: string;
}

export interface SessionHistoryItem {
    timestamp: string;
    title?: string;
    url?: string;
}

const MAX_MEMORY = 100;

export class McpTaskMemory {
    private readonly tasks: TaskNode[] = [];
    private readonly sessions: SessionHistoryItem[] = [];

    create(action: string, url: string, parentId?: string): TaskNode {
        const node: TaskNode = {
            id: `v2-${Math.random().toString(36).substring(7)}`,
            action,
            url,
            timestamp: new Date().toISOString(),
            parentId,
            status: "pending",
        };
        this.tasks.push(node);
        this.trim(this.tasks);
        return node;
    }

    recordSession(item: Omit<SessionHistoryItem, "timestamp">): void {
        this.sessions.unshift({ timestamp: new Date().toISOString(), ...item });
        this.trim(this.sessions);
    }

    graph(): TaskNode[] {
        return this.tasks;
    }

    history(): SessionHistoryItem[] {
        return this.sessions;
    }

    private trim<T>(items: T[]): void {
        while (items.length > MAX_MEMORY) items.shift();
    }
}
