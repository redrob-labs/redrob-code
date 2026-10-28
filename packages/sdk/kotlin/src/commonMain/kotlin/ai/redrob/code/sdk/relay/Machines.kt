// Hand-written: relay frames and server bodies that openapi.json does not describe.
// Mirrors packages/redrob/src/desk/frames.ts (MachineFrame) and the redrob-chat
// GET /mobile/machines, GET /desktop/machines body.
package ai.redrob.code.sdk.relay

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Namespace of the plain-JSON action frame a desk broadcasts in its relay room. */
const val MACHINE_NAMESPACE: String = "desk.machine"

@Serializable
enum class MachineKind {
    @SerialName("desktop") DESKTOP,
    @SerialName("server") SERVER,
    @SerialName("cloud") CLOUD,
}

@Serializable
enum class MachineAccess {
    @SerialName("read_only") READ_ONLY,
    @SerialName("ask") ASK,
    @SerialName("trusted") TRUSTED,
}

/** Payload of a `desk.machine` action frame. */
@Serializable
data class MachineFrame(
    val v: Int = 1,
    val machineId: String,
    val name: String,
    val kind: MachineKind,
    val os: String,
    /** False in the last frame a desk sends before it leaves. */
    val online: Boolean,
    /** Sessions with a turn running right now. */
    val sessions: Int,
    /** Permission requests waiting for an answer. */
    val approvals: Int,
)

/** One entry of the machine list kept by the relay server. */
@Serializable
data class Machine(
    val machineId: String,
    val name: String,
    val kind: MachineKind,
    val os: String,
    val online: Boolean,
    val sessions: Int,
    val approvals: Int,
    /** ISO 8601 time of the last `desk.machine` frame. */
    val lastSeen: String,
)

/** Body of GET /mobile/machines and GET /desktop/machines. Already sorted by the server. */
@Serializable
data class MachinesResponse(
    val machines: List<Machine>,
)

/** Body of GET /desk/capabilities on a desk (also reachable through a `req` frame). */
@Serializable
data class DeskCapabilities(
    val v: Int,
    val approvalModes: List<String>,
    val defaultApproval: String,
    val machineId: String,
    val access: MachineAccess = MachineAccess.TRUSTED,
)
