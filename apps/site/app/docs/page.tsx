import { DocRoute, docMetadata } from './render';

export const metadata = docMetadata('quickstart');
export default function Page() { return <DocRoute slug="quickstart" />; }
