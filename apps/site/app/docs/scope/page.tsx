import { DocRoute, docMetadata } from '../render';

export const metadata = docMetadata('scope');
export default function Page() { return <DocRoute slug="scope" />; }
