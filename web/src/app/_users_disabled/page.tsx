import UsersClient from "./users-client";

export default function Page({
  searchParams,
}: { searchParams: { serverId?: string; days?: string } }) {
  const serverId =
    searchParams?.serverId ?? process.env.NEXT_PUBLIC_SERVER_ID ?? "";
  const days = Number(searchParams?.days ?? "7");
  return <UsersClient serverId={serverId} days={days} />;
}
