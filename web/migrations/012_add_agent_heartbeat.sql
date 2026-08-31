-- Agent liveness. The Worker cannot see whether the machine behind a session is
-- alive: a crash or power loss leaves the row looking fresh forever, and
-- /api/connect keeps handing out a dead tunnel. agentOnline is the agent's
-- explicit goodbye (0 = shut down on purpose), agentSeenAt its last heartbeat.
-- NULL in both = a row no heartbeat ever touched (agent too old to send them):
-- "unknown", never "offline", so pre-heartbeat agents keep logging in.
ALTER TABLE sessions ADD COLUMN agentOnline INTEGER;
ALTER TABLE sessions ADD COLUMN agentSeenAt TEXT;
