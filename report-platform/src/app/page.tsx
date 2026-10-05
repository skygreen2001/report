import { redirect } from 'next/navigation';

// 根路径：重定向到平台根应用的开发者入口
export default function Home() {
  redirect('/platform/d');
}
